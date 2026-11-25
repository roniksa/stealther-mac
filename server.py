#!/usr/bin/env python3
"""Stealther tracker server (Python stdlib only).

Receives Wi-Fi / Bluetooth LE readings from StealtherScanner.app, keeps a
persistent record of every device in SQLite (first/last seen, presence
sessions, RSSI samples) and serves the web UI with the radar and list.

    python3 server.py            # real data from the scanner app
    python3 server.py --demo     # simulated devices (separate database)
"""
import argparse
import csv
import io
import json
import math
import os
import random
import secrets
import socket
import sqlite3
import statistics
import threading
import time
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")

ACTIVE_WINDOW = {"ble": 20, "wifi": 45}   # seconds since last sighting = "active now"
SMOOTH_WINDOW = {"ble": 10, "wifi": 40}   # seconds of samples used for the smoothed RSSI
PERSIST_EVERY = 5                          # store at most one RSSI sample per device per N s

# --------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------

COMPANY_IDS = {
    0x004C: "Apple", 0x0006: "Microsoft", 0x0075: "Samsung", 0x00E0: "Google",
    0x0087: "Garmin", 0x0157: "Huami / Amazfit", 0x038F: "Xiaomi", 0x0059: "Nordic Semi",
    0x02E5: "Espressif", 0x0499: "Ruuvi", 0x067C: "Tile", 0x000F: "Broadcom",
    0x0171: "Amazon", 0x009E: "Bose", 0x012D: "Sony", 0x0002: "Intel", 0x000A: "Qualcomm",
}

APPLE_TYPES = {
    0x02: "iBeacon", 0x05: "AirDrop", 0x07: "AirPods / Beats", 0x08: "Hey Siri",
    0x09: "AirPlay target", 0x0A: "AirPlay source", 0x0B: "Apple Watch", 0x0C: "Handoff",
    0x0D: "Wi-Fi settings", 0x0E: "Instant Hotspot", 0x0F: "Nearby Action",
    0x10: "Apple device (Nearby Info)", 0x12: "Find My",
}

BASE_UUID_SUFFIX = "-0000-1000-8000-00805F9B34FB"


def short_uuid(u):
    u = str(u).upper()
    if u.endswith(BASE_UUID_SUFFIX) and u.startswith("0000"):
        return u[4:8]
    return u


def parse_apple(p):
    """Parse Apple Continuity TLVs. Returns (dtype, tags, p1m, types)."""
    dtype, tags, p1m, types = None, [], None, []
    i = 0
    while i + 1 < len(p):
        t, ln = p[i], p[i + 1]
        v = p[i + 2:i + 2 + ln]
        i += 2 + ln
        types.append(APPLE_TYPES.get(t, f"Apple Continuity 0x{t:02X}"))
        if t == 0x12:
            if ln >= 25:
                hint = {1: "AirTag", 2: "Find My accessory", 3: "AirPods"}.get((v[0] >> 4) & 3 if v else 0)
                dtype = "Find My — separated from owner" + (f" (likely {hint})" if hint else "")
                tags += ["tracker", "separated"]
            else:
                dtype = dtype or "Find My — near owner"
                tags.append("findmy")
        elif t == 0x02 and ln == 0x15 and len(v) >= 21:
            dtype = dtype or "iBeacon"
            tags.append("beacon")
            p1m = v[20] - 256 if v[20] > 127 else v[20]
        elif t == 0x07:
            dtype = dtype or "AirPods / Beats"
        elif t in (0x09, 0x0A):
            dtype = dtype or "AirPlay device (Apple TV / HomePod / Mac)"
        elif t == 0x0B:
            dtype = dtype or "Apple Watch"
    if dtype is None and types:
        dtype = types[0]
    return dtype, tags, p1m, types


def classify_ble(name, mfg_hex, services, sdata):
    vendor, dtype, tags, p1m, extra = None, None, [], None, {}
    if mfg_hex and len(mfg_hex) >= 4:
        try:
            b = bytes.fromhex(mfg_hex)
            cid = b[0] | (b[1] << 8)
            vendor = COMPANY_IDS.get(cid, f"Company 0x{cid:04X}")
            if cid == 0x004C:
                dtype, t2, p1m, types = parse_apple(b[2:])
                tags += t2
                extra["apple"] = types
            elif cid == 0x0006:
                dtype = "Windows / Microsoft device"
        except ValueError:
            pass
    svc = {short_uuid(s) for s in services or []}
    sd = {short_uuid(k): v for k, v in (sdata or {}).items()}
    svc |= set(sd)
    if svc & {"FEED", "FEEC"}:
        vendor, dtype = "Tile", "Tile tracker"
        tags.append("tracker")
    if "FD5A" in svc:
        vendor, dtype = "Samsung", "Galaxy SmartTag"
        tags.append("tracker")
    if "FEAA" in sd:
        try:
            frame = bytes.fromhex(sd["FEAA"])[0]
        except (ValueError, IndexError):
            frame = None
        if frame in (0x40, 0x41):
            vendor, dtype = vendor or "Google", "Find My Device tracker"
            tags.append("tracker")
            if frame == 0x41:
                tags.append("separated")
        else:
            dtype = dtype or "Eddystone beacon"
            tags.append("beacon")
    if "FE2C" in svc:
        dtype = dtype or "Fast Pair device"
        vendor = vendor or "Google Fast Pair"
    if "FD6F" in svc:
        dtype = dtype or "Phone (exposure notifications)"
    for u, label in (("180D", "Heart-rate sensor"), ("1812", "Keyboard / mouse (HID)"),
                     ("1826", "Fitness machine"), ("181A", "Environmental sensor")):
        if u in svc:
            dtype = dtype or label
    if name:
        low = name.lower()
        for key, label in (("airpods", "AirPods"), ("airtag", "AirTag"), ("watch", "Smartwatch"),
                           ("tile", "Tile tracker"), ("smarttag", "Galaxy SmartTag"),
                           ("buds", "Earbuds"), ("tv", "TV"), ("macbook", "Mac"), ("iphone", "iPhone")):
            if key in low:
                dtype = dtype or label
                if key in ("airtag", "tile", "smarttag"):
                    tags.append("tracker")
                break
    return vendor, dtype, sorted(set(tags)), p1m, extra


def mac_randomized(mac):
    try:
        return bool(int(mac.split(":")[0], 16) & 0x02)
    except (ValueError, IndexError, AttributeError):
        return False


def classify_wifi(w):
    tags = []
    ssid = w.get("ssid")
    if not ssid:
        # With a BSSID visible, Location is granted, so a missing SSID means a hidden network.
        tags.append("hidden" if (ssid == "" or w.get("bssid")) else "name-hidden")
    if w.get("connected"):
        tags.append("connected")
    if w.get("security") == "Open":
        tags.append("open")
    if w.get("ibss"):
        tags.append("ad-hoc")
    if w.get("bssid") and mac_randomized(w["bssid"]):
        tags.append("randomized")
    dtype = "Access point"
    low = (ssid or "").lower()
    if "iphone" in low or "android" in low or "galaxy" in low or "pixel" in low:
        dtype = "Phone hotspot"
        tags.append("hotspot")
    elif low.startswith("direct-"):
        dtype = "Wi-Fi Direct (printer / TV)"
    return dtype, sorted(set(tags))


# --------------------------------------------------------------------------
# Tracker state + persistence
# --------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices(
  id TEXT PRIMARY KEY, kind TEXT, name TEXT, vendor TEXT, dtype TEXT, tags TEXT, meta TEXT,
  first_seen REAL, last_seen REAL, sightings INTEGER DEFAULT 0, total_closed REAL DEFAULT 0,
  sessions INTEGER DEFAULT 0, session_start REAL, last_rssi REAL, max_rssi REAL,
  label TEXT, p1m REAL, watched INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sightings(device_id TEXT, ts REAL, rssi REAL);
CREATE INDEX IF NOT EXISTS ix_sightings ON sightings(device_id, ts);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, start REAL, end REAL,
  min_rssi REAL, max_rssi REAL, samples INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_sessions ON sessions(device_id, start);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS ix_sightings_ts ON sightings(ts);
CREATE TABLE IF NOT EXISTS fixes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, lat REAL, lon REAL, t0 REAL, t1 REAL, note TEXT);
"""

FIX_COLS = ["id", "lat", "lon", "t0", "t1", "note"]
GEO_META = ("ssid", "bssid", "band", "channel", "security", "tx_power", "beacon_p1m")

DEV_COLS = ["id", "kind", "name", "vendor", "dtype", "tags", "meta", "first_seen", "last_seen",
            "sightings", "total_closed", "sessions", "session_start", "last_rssi", "max_rssi",
            "label", "p1m", "watched"]


class Tracker:
    def __init__(self, db_path, gap, retention_days):
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self.lock = threading.RLock()
        self.gap = gap
        self.retention = retention_days * 86400
        self.db = sqlite3.connect(db_path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.devs = {}
        self.scanner = {"last_post": None, "status": {}, "source": None, "wifi_scan": None}
        self.geo_cache = {}  # (fix id, t0, t1) -> per-device RSSI summary for closed fixes
        self._load()

    def _load(self):
        cur = self.db.execute(f"SELECT {','.join(DEV_COLS)} FROM devices")
        for row in cur:
            d = dict(zip(DEV_COLS, row))
            d["tags"] = json.loads(d["tags"] or "[]")
            d["meta"] = json.loads(d["meta"] or "{}")
            d["hist"] = deque(maxlen=400)
            d["last_persist"] = 0
            d["cur_sid"] = None
            self.devs[d["id"]] = d
        for did, sid in self.db.execute("SELECT device_id, MAX(id) FROM sessions GROUP BY device_id"):
            if did in self.devs:
                self.devs[did]["cur_sid"] = sid

    # -- ingest -----------------------------------------------------------

    def _observe(self, ts, did, kind, samples, name, meta, vendor, dtype, tags, p1m_hint):
        d = self.devs.get(did)
        if d is None:
            d = {c: None for c in DEV_COLS}
            d.update(id=did, kind=kind, first_seen=ts, last_seen=ts, sightings=0, total_closed=0.0,
                     sessions=0, watched=0, tags=[], meta={}, hist=deque(maxlen=400),
                     last_persist=0, cur_sid=None)
            self.devs[did] = d
            self.db.execute("INSERT INTO devices(id, kind, first_seen, last_seen) VALUES (?,?,?,?)",
                            (did, kind, ts, ts))
        lo, hi = min(samples), max(samples)
        if d["session_start"] is None or ts - d["last_seen"] > self.gap:
            if d["session_start"] is not None:
                d["total_closed"] += max(0.0, d["last_seen"] - d["session_start"])
            d["session_start"] = ts
            d["sessions"] += 1
            c = self.db.execute(
                "INSERT INTO sessions(device_id, start, end, min_rssi, max_rssi, samples) VALUES (?,?,?,?,?,0)",
                (did, ts, ts, lo, hi))
            d["cur_sid"] = c.lastrowid
        d["last_seen"] = ts
        d["sightings"] += 1
        if name:
            d["name"] = name
        d["meta"].update({k: v for k, v in meta.items() if v is not None})
        if p1m_hint is not None:
            d["meta"]["beacon_p1m"] = p1m_hint
        d["vendor"] = vendor or d["vendor"]
        d["dtype"] = dtype or d["dtype"]
        d["tags"] = sorted(set(tags) | ({"watched"} & set(d["tags"])))
        for r in samples:
            d["hist"].append((ts, r))
        med = statistics.median(samples)
        d["last_rssi"] = med
        d["max_rssi"] = hi if d["max_rssi"] is None else max(d["max_rssi"], hi)
        if d["cur_sid"]:
            self.db.execute(
                "UPDATE sessions SET end=?, min_rssi=MIN(min_rssi, ?), max_rssi=MAX(max_rssi, ?), "
                "samples=samples+? WHERE id=?", (ts, lo, hi, len(samples), d["cur_sid"]))
        if ts - d["last_persist"] >= PERSIST_EVERY:
            self.db.execute("INSERT INTO sightings(device_id, ts, rssi) VALUES (?,?,?)", (did, ts, med))
            d["last_persist"] = ts
        self.db.execute(
            "UPDATE devices SET name=?, vendor=?, dtype=?, tags=?, meta=?, last_seen=?, sightings=?, "
            "total_closed=?, sessions=?, session_start=?, last_rssi=?, max_rssi=? WHERE id=?",
            (d["name"], d["vendor"], d["dtype"], json.dumps(d["tags"]), json.dumps(d["meta"]),
             d["last_seen"], d["sightings"], d["total_closed"], d["sessions"], d["session_start"],
             d["last_rssi"], d["max_rssi"], did))

    def ingest(self, payload, source):
        ts = time.time()
        with self.lock:
            for b in payload.get("ble") or []:
                try:
                    samples = [int(x) for x in b.get("samples", []) if -127 < int(x) < 20]
                except (TypeError, ValueError):
                    continue
                if not samples or not b.get("id"):
                    continue
                uid = str(b["id"])[:64]
                services = [str(s) for s in (b.get("services") or [])][:32]
                sdata = {str(k): str(v) for k, v in (b.get("service_data") or {}).items()}
                mfg = b.get("mfg")
                vendor, dtype, tags, p1m, extra = classify_ble(b.get("name"), mfg, services, sdata)
                meta = {"tx_power": b.get("tx"), "mfg": mfg, "services": services or None,
                        "service_data": sdata or None, "connectable": b.get("connectable"), **extra}
                self._observe(ts, "ble:" + uid, "ble", samples, b.get("name"), meta,
                              vendor, dtype, tags, p1m)
            if "wifi" in payload:
                self.scanner["wifi_scan"] = ts
                seen = set()
                for w in payload.get("wifi") or []:
                    try:
                        rssi = int(w.get("rssi"))
                    except (TypeError, ValueError):
                        continue
                    if not -127 < rssi < 20:
                        continue
                    bssid, ssid = w.get("bssid"), w.get("ssid")
                    if bssid:
                        did = "wifi:" + bssid.lower()
                    else:  # no Location permission -> macOS hides SSID/BSSID
                        did = f"wifi:anon:{ssid or ''}:{w.get('channel')}:{w.get('security')}"
                    if did in seen:
                        continue
                    seen.add(did)
                    dtype, tags = classify_wifi(w)
                    meta = {k: w.get(k) for k in ("ssid", "bssid", "channel", "band", "width",
                                                  "security", "noise", "country", "beacon")}
                    meta["connected"] = bool(w.get("connected"))
                    name = ssid if ssid else ("(hidden network)" if (ssid == "" or bssid) else None)
                    self._observe(ts, did, "wifi", [rssi], name, meta, None, dtype, tags, None)
            self.db.commit()
            self.scanner.update(last_post=ts, status=payload.get("status") or {}, source=source)

    # -- views ------------------------------------------------------------

    def _view(self, d, now):
        kind = d["kind"]
        recent = [r for t, r in d["hist"] if now - t <= SMOOTH_WINDOW[kind]]
        if not recent and d["hist"]:
            recent = [d["hist"][-1][1]]
        smooth = statistics.median(recent) if recent else d["last_rssi"]
        std = statistics.pstdev(recent) if len(recent) > 1 else 0.0
        age = now - d["last_seen"]
        present = d["session_start"] is not None and age <= self.gap
        cur = (d["last_seen"] - d["session_start"]) if d["session_start"] is not None else 0.0
        return {
            "id": d["id"], "kind": kind, "name": d["name"], "label": d["label"],
            "vendor": d["vendor"], "dtype": d["dtype"], "tags": d["tags"], "meta": d["meta"],
            "first_seen": d["first_seen"], "last_seen": d["last_seen"], "age": age,
            "active": age <= ACTIVE_WINDOW[kind], "present": present,
            "here_for": cur if present else 0.0, "total_seconds": d["total_closed"] + cur,
            "sessions": d["sessions"], "sightings": d["sightings"],
            "rssi": d["last_rssi"], "rssi_smooth": smooth, "rssi_std": std, "rssi_max": d["max_rssi"],
            "p1m": d["p1m"], "watched": bool(d["watched"]),
        }

    def list(self, since):
        now = time.time()
        with self.lock:
            devs = [d for d in self.devs.values() if since <= 0 or now - d["last_seen"] <= since]
            devs.sort(key=lambda d: -d["last_seen"])
            out = [self._view(d, now) for d in devs[:3000]]
            counts = {"total": len(self.devs),
                      "active": sum(1 for d in self.devs.values()
                                    if now - d["last_seen"] <= ACTIVE_WINDOW[d["kind"]])}
        return {"now": now, "gap": self.gap, "counts": counts, "devices": out,
                "scanner": self.status(now)}

    def status(self, now=None):
        now = now or time.time()
        s = dict(self.scanner)
        s["online"] = s["last_post"] is not None and now - s["last_post"] < 10
        return s

    def detail(self, did, minutes):
        now = time.time()
        with self.lock:
            d = self.devs.get(did)
            if not d:
                return None
            v = self._view(d, now)
            v["history"] = self.db.execute(
                "SELECT ts, rssi FROM sightings WHERE device_id=? AND ts>=? ORDER BY ts",
                (did, now - minutes * 60)).fetchall()
            v["session_list"] = [
                dict(zip(("start", "end", "min_rssi", "max_rssi", "samples"), r))
                for r in self.db.execute(
                    "SELECT start, end, min_rssi, max_rssi, samples FROM sessions WHERE device_id=? "
                    "ORDER BY start DESC LIMIT 100", (did,))]
        v["now"] = now
        return v

    def update_device(self, did, body):
        with self.lock:
            d = self.devs.get(did)
            if not d:
                return False
            if "label" in body:
                d["label"] = (str(body["label"]).strip()[:80] or None) if body["label"] is not None else None
            if "p1m" in body:
                d["p1m"] = None if body["p1m"] is None else max(-100.0, min(0.0, float(body["p1m"])))
            if "watched" in body:
                d["watched"] = 1 if body["watched"] else 0
            self.db.execute("UPDATE devices SET label=?, p1m=?, watched=? WHERE id=?",
                            (d["label"], d["p1m"], d["watched"], did))
            self.db.commit()
        return True

    # -- location fixes + geolocation data ---------------------------------

    def _fix_rows(self):
        return [dict(zip(FIX_COLS, r)) for r in
                self.db.execute(f"SELECT {','.join(FIX_COLS)} FROM fixes ORDER BY t0")]

    @staticmethod
    def _clean_fix(body, now, cur=None):
        f = dict(cur or {})
        for k, lo, hi in (("lat", -90, 90), ("lon", -180, 180)):
            if k in body:
                v = float(body[k])
                if not lo <= v <= hi:
                    raise ValueError(k)
                f[k] = v
        for k in ("t0", "t1"):
            if k in body:
                v = body[k]
                if v is not None:
                    v = float(v)
                    if not now - 400 * 86400 <= v <= now + 86400:
                        raise ValueError(k)
                f[k] = v
        if "note" in body:
            f["note"] = (str(body["note"]).strip()[:120] or None) if body["note"] is not None else None
        if f.get("lat") is None or f.get("lon") is None or f.get("t0") is None:
            raise ValueError("lat, lon and t0 are required")
        if f.get("t1") is not None and f["t1"] < f["t0"]:
            raise ValueError("end is before start")
        return f

    def add_fix(self, body):
        now = time.time()
        body = dict(body)
        body.setdefault("t0", now)
        if body.get("dwell") is not None and "t1" not in body:
            body["t1"] = float(body["t0"]) + max(10.0, min(86400.0, float(body["dwell"])))
        f = self._clean_fix(body, now)
        with self.lock:
            if f["t0"] >= now - 5:
                # Standing somewhere new ends any spot that is still recording.
                self.db.execute("UPDATE fixes SET t1=? WHERE (t1 IS NULL OR t1>?) AND t0<?",
                                (f["t0"], f["t0"], f["t0"]))
            c = self.db.execute("INSERT INTO fixes(lat, lon, t0, t1, note) VALUES (?,?,?,?,?)",
                                (f["lat"], f["lon"], f["t0"], f.get("t1"), f.get("note")))
            self.db.commit()
            f["id"] = c.lastrowid
        return f

    def update_fix(self, fid, body):
        now = time.time()
        with self.lock:
            row = self.db.execute(f"SELECT {','.join(FIX_COLS)} FROM fixes WHERE id=?", (fid,)).fetchone()
            if not row:
                return None
            if body.get("delete"):
                self.db.execute("DELETE FROM fixes WHERE id=?", (fid,))
                self.db.commit()
                return {"deleted": fid}
            cur = dict(zip(FIX_COLS, row))
            if body.get("stop"):
                body = {"t1": max(cur["t0"], min(now, cur["t1"] or now))}
            f = self._clean_fix(body, now, cur)
            self.db.execute("UPDATE fixes SET lat=?, lon=?, t0=?, t1=?, note=? WHERE id=?",
                            (f["lat"], f["lon"], f["t0"], f["t1"], f["note"], fid))
            self.db.commit()
        return f

    def _fix_obs(self, f, now):
        end = min(f["t1"], now) if f["t1"] is not None else now
        key = (f["id"], f["t0"], f["t1"])
        if end < now - 30 and key in self.geo_cache:
            return self.geo_cache[key]
        per = {}
        for did, r in self.db.execute("SELECT device_id, rssi FROM sightings WHERE ts>=? AND ts<=?",
                                      (f["t0"], end)):
            per.setdefault(did, []).append(r)
        obs = {did: (statistics.median(v), len(v), max(v)) for did, v in per.items()}
        if end < now - 30:
            self.geo_cache[key] = obs
        return obs

    def geo(self):
        now = time.time()
        with self.lock:
            fixes = self._fix_rows()
            devs = {}
            for f in fixes:
                obs = self._fix_obs(f, now)
                heard = {"wifi": 0, "ble": 0}
                for did, (med, n, mx) in obs.items():
                    d = self.devs.get(did)
                    if d is None:
                        continue
                    heard[d["kind"]] += 1
                    e = devs.get(did)
                    if e is None:
                        e = devs[did] = {
                            "id": did, "kind": d["kind"], "name": d["name"], "label": d["label"],
                            "vendor": d["vendor"], "dtype": d["dtype"], "tags": d["tags"],
                            "meta": {k: d["meta"].get(k) for k in GEO_META if d["meta"].get(k) is not None},
                            "p1m": d["p1m"], "first_seen": d["first_seen"], "last_seen": d["last_seen"],
                            "active": now - d["last_seen"] <= ACTIVE_WINDOW[d["kind"]], "obs": []}
                    e["obs"].append([f["id"], round(med, 1), n, mx])
                f["heard"] = heard
                f["open"] = f["t1"] is None or f["t1"] > now
            stale = {k for k in self.geo_cache if k[0] not in {f["id"] for f in fixes}}
            for k in stale:
                del self.geo_cache[k]
        return {"now": now, "fixes": fixes, "devices": list(devs.values())}

    def get_settings(self):
        with self.lock:
            return {k: json.loads(v) for k, v in self.db.execute("SELECT key, value FROM settings")}

    def put_settings(self, body):
        with self.lock:
            for k, v in body.items():
                self.db.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?,?)",
                                (str(k)[:64], json.dumps(v)[:4096]))
            self.db.commit()

    def export_csv(self):
        now = time.time()
        buf = io.StringIO()
        w = csv.writer(buf)
        cols = ["id", "kind", "label", "name", "vendor", "dtype", "tags", "first_seen", "last_seen",
                "total_seconds", "sessions", "sightings", "rssi", "rssi_max"]
        w.writerow(cols)
        with self.lock:
            for d in sorted(self.devs.values(), key=lambda d: -d["last_seen"]):
                v = self._view(d, now)
                row = [v[c] for c in cols]
                row[6] = " ".join(v["tags"])
                for i in (7, 8):
                    row[i] = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(row[i]))
                w.writerow(row)
        return buf.getvalue()

    def prune(self):
        with self.lock:
            self.db.execute("DELETE FROM sightings WHERE ts < ?", (time.time() - self.retention,))
            self.db.commit()


# --------------------------------------------------------------------------
# Demo data
# --------------------------------------------------------------------------

def demo_loop(tracker):
    rng = random.Random(7)

    def rssi_at(p1m, dist, n=2.8):
        return round(p1m - 10 * n * math.log10(max(dist, 0.3)) + rng.gauss(0, 3.5))

    def apple(t, payload):
        return "4c00" + bytes([t, len(payload)]).hex() + payload.hex()

    ble = [
        dict(id=str(uuid.UUID(int=rng.getrandbits(128))), name=n, mfg=m, svc=s, tx=tx, d=d, per=p, on=on)
        for n, m, s, tx, d, p, on in [
            (None, apple(0x12, bytes([0x10]) + rng.randbytes(24)), [], None, 1.5, 60, (0, 1e9)),
            ("AirPods Pro", apple(0x07, rng.randbytes(25)), [], None, 0.6, 30, (0, 1e9)),
            (None, apple(0x10, rng.randbytes(5)), [], 12, 3.0, 45, (0, 1e9)),
            (None, apple(0x10, rng.randbytes(5)), [], 12, 7.0, 90, (20, 400)),
            (None, apple(0x09, rng.randbytes(8)), [], None, 9.0, 1e9, (0, 1e9)),
            ("Tile", None, ["FEED"], None, 12.0, 70, (60, 1e9)),
            ("Galaxy Watch5", "7500" + rng.randbytes(10).hex(), [], 0, 4.0, 50, (0, 1e9)),
            (None, "0600" + rng.randbytes(20).hex(), [], None, 15.0, 1e9, (0, 1e9)),
            ("MX Keys", None, ["1812"], None, 0.8, 1e9, (0, 1e9)),
            ("Polar H10", None, ["180D"], None, 18.0, 40, (100, 260)),
            (None, apple(0x02, rng.randbytes(16) + bytes([0, 1, 0, 2, 0xC5])), [], None, 5.0, 1e9, (0, 1e9)),
            ("[TV] Living Room", "7500" + rng.randbytes(8).hex(), [], None, 6.0, 1e9, (0, 1e9)),
        ]]
    wifi = [
        dict(ssid="HomeNet-5G", bssid="a4:2b:b0:11:22:33", channel=149, band="5GHz", sec="WPA2/WPA3 Personal", d=2.0, connected=True),
        dict(ssid="HomeNet", bssid="a4:2b:b0:11:22:32", channel=6, band="2.4GHz", sec="WPA2 Personal", d=2.0),
        dict(ssid="NETGEAR47", bssid="9c:3d:cf:aa:bb:01", channel=11, band="2.4GHz", sec="WPA2 Personal", d=14.0),
        dict(ssid="xfinitywifi", bssid="56:3a:ab:01:02:03", channel=1, band="2.4GHz", sec="Open", d=30.0),
        dict(ssid="", bssid="3c:84:6a:77:88:99", channel=44, band="5GHz", sec="WPA2 Personal", d=20.0),
        dict(ssid="Jake's iPhone", bssid="b2:c1:44:12:34:56", channel=149, band="5GHz", sec="WPA2/WPA3 Personal", d=8.0),
        dict(ssid="DIRECT-7F-HP OfficeJet", bssid="9e:1f:00:aa:12:ff", channel=6, band="2.4GHz", sec="WPA2 Personal", d=11.0),
    ]
    p1m_w = {"2.4GHz": -30, "5GHz": -33}
    t0, last_wifi = time.time(), -10.0
    while True:
        t = time.time() - t0
        payload = {"ble": [], "status": {"bluetooth": "poweredOn", "location": "authorized", "demo": True}}
        for b in ble:
            if not (b["on"][0] <= t <= b["on"][1]) or rng.random() < 0.08:
                continue
            dist = b["d"] * (1 + 0.45 * math.sin(t * 2 * math.pi / b["per"]))
            rec = {"id": b["id"], "samples": [rssi_at(-59, dist) for _ in range(rng.randint(2, 6))],
                   "connectable": True}
            for k_src, k_dst in (("name", "name"), ("mfg", "mfg"), ("tx", "tx")):
                if b[k_src] is not None:
                    rec[k_dst] = b[k_src]
            if b["svc"]:
                rec["services"] = b["svc"]
            payload["ble"].append(rec)
        if t - last_wifi >= 10:
            last_wifi = t
            payload["wifi"] = [
                {"ssid": w["ssid"], "bssid": w["bssid"], "channel": w["channel"], "band": w["band"],
                 "security": w["sec"], "rssi": rssi_at(p1m_w[w["band"]], w["d"], 3.0), "noise": -92,
                 "connected": w.get("connected", False)} for w in wifi]
        tracker.ingest(payload, "demo")
        time.sleep(2)


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png"}


def make_handler(tracker, port, lan_token=None):
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    if lan_token:
        # --lan: the phone addresses the Mac by IP or by its .local name. IP literals can't be
        # DNS-rebound, so they're safe to accept; other LAN clients may only POST with the token.
        name = socket.gethostname().split(".")[0].lower()
        allowed_hosts |= {f"{name}.local:{port}", f"{name}:{port}"}

    class Handler(BaseHTTPRequestHandler):
        server_version = "Stealther/1.0"

        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, code=200):
            self._send(code, json.dumps(obj).encode(), "application/json")

        def _local(self):
            return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

        def _host_ok(self):
            # Blocks DNS-rebinding: only answer requests addressed to localhost.
            host = self.headers.get("Host") or ""
            if host not in allowed_hosts and not (lan_token and _ip_host(host, port)):
                self._send(403, b"forbidden", "text/plain")
                return False
            if not self._local():
                # --lan: other machines may only send readings and spots, with the token.
                path = urlparse(self.path).path
                if self.command != "POST" or path not in ("/ingest", "/api/fixes"):
                    self._send(403, b"forbidden", "text/plain")
                    return False
                if not secrets.compare_digest(self.headers.get("X-Stealther-Token") or "", lan_token or ""):
                    self._json({"error": "bad token"}, 401)
                    return False
            return True

        def _body(self):
            # Requiring JSON forces a CORS preflight, so other websites can't post here.
            if "application/json" not in (self.headers.get("Content-Type") or ""):
                return None
            n = int(self.headers.get("Content-Length") or 0)
            if n > 5_000_000:
                return None
            try:
                return json.loads(self.rfile.read(n) or b"{}")
            except json.JSONDecodeError:
                return None

        def do_GET(self):
            if not self._host_ok():
                return
            u = urlparse(self.path)
            q = parse_qs(u.query)
            if u.path == "/api/devices":
                self._json(tracker.list(float(q.get("since", ["900"])[0])))
            elif u.path.startswith("/api/device/"):
                v = tracker.detail(unquote(u.path[len("/api/device/"):]), float(q.get("minutes", ["30"])[0]))
                self._json(v) if v else self._json({"error": "not found"}, 404)
            elif u.path == "/api/status":
                self._json(tracker.status())
            elif u.path == "/api/settings":
                self._json(tracker.get_settings())
            elif u.path == "/api/geo":
                self._json(tracker.geo())
            elif u.path == "/api/export.csv":
                self._send(200, tracker.export_csv().encode(), "text/csv; charset=utf-8")
            else:
                rel = "index.html" if u.path in ("", "/") else u.path.lstrip("/")
                path = os.path.realpath(os.path.join(WEB, rel))
                if not path.startswith(os.path.realpath(WEB) + os.sep) or not os.path.isfile(path):
                    self._send(404, b"not found", "text/plain")
                    return
                with open(path, "rb") as f:
                    self._send(200, f.read(), MIME.get(os.path.splitext(path)[1], "application/octet-stream"))

        def do_POST(self):
            if not self._host_ok():
                return
            u = urlparse(self.path)
            body = self._body()
            if body is None:
                self._json({"error": "expected JSON"}, 400)
            elif u.path == "/ingest":
                tracker.ingest(body, "scanner")
                self._json({"ok": True})
            elif u.path.startswith("/api/device/"):
                ok = tracker.update_device(unquote(u.path[len("/api/device/"):]), body)
                self._json({"ok": ok}, 200 if ok else 404)
            elif u.path == "/api/settings":
                tracker.put_settings(body)
                self._json({"ok": True})
            elif u.path == "/api/fixes" or u.path.startswith("/api/fix/"):
                try:
                    if u.path == "/api/fixes":
                        f = tracker.add_fix(body)
                    else:
                        f = tracker.update_fix(int(u.path[len("/api/fix/"):]), body)
                except (TypeError, ValueError) as e:
                    self._json({"error": f"bad value: {e}"}, 400)
                    return
                self._json(f) if f else self._json({"error": "not found"}, 404)
            else:
                self._json({"error": "not found"}, 404)

    return Handler


def _ip_host(host, port):
    """True if a Host header is an IP literal with our port, e.g. 192.168.1.20:8765."""
    h, _, p = host.rpartition(":")
    if p != str(port):
        return False
    try:
        socket.inet_pton(socket.AF_INET6 if h.startswith("[") else socket.AF_INET, h.strip("[]"))
        return True
    except OSError:
        return False


def _lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # no packet is sent; picks the LAN interface
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ips)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--db", help="SQLite path (default data/stealther.db, or data/demo.db with --demo)")
    ap.add_argument("--gap", type=float, default=120,
                    help="seconds without a sighting before a presence session ends (default 120)")
    ap.add_argument("--retention-days", type=float, default=30, help="keep RSSI samples this long")
    ap.add_argument("--demo", action="store_true", help="generate simulated devices")
    ap.add_argument("--lan", action="store_true",
                    help="also listen on the local network so the iPhone app can sync (needs the printed token)")
    ap.add_argument("--lan-token", help="token for --lan (default: random, printed at start)")
    a = ap.parse_args()
    db = a.db or os.path.join(ROOT, "data", "demo.db" if a.demo else "stealther.db")
    tracker = Tracker(db, a.gap, a.retention_days)

    def pruner():
        while True:
            tracker.prune()
            time.sleep(3600)

    threading.Thread(target=pruner, daemon=True).start()
    if a.demo:
        threading.Thread(target=demo_loop, args=(tracker,), daemon=True).start()
    token = (a.lan_token or secrets.token_urlsafe(9)) if a.lan else None
    srv = ThreadingHTTPServer(("0.0.0.0" if a.lan else "127.0.0.1", a.port), make_handler(tracker, a.port, token))
    print(f"Stealther running on http://127.0.0.1:{a.port}  (db: {db}{', DEMO' if a.demo else ''})", flush=True)
    if token:
        addrs = ", ".join(f"{ip}:{a.port}" for ip in _lan_ips()) or f"<this Mac's IP>:{a.port}"
        print(f"LAN sync on: in the iPhone app set Mac address {addrs} and token {token}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
