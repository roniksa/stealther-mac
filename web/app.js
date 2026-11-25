'use strict';
// Stealther UI: polls the local server, estimates distance from RSSI, draws the
// radar and the device list.

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// Path-loss exponents per environment (log-distance model).
const ENVS = {
  outdoor_open: { label: 'Outdoor · open, line of sight', n: 2.0 },
  outdoor_urban: { label: 'Outdoor · urban / foliage', n: 2.7 },
  indoor_room: { label: 'Indoor · same room', n: 2.2 },
  indoor_home: { label: 'Indoor · home, a few walls', n: 3.0 },
  indoor_office: { label: 'Indoor · office, many walls', n: 3.5 },
  indoor_dense: { label: 'Indoor · dense / concrete', n: 4.0 },
  custom: { label: 'Custom exponent…', n: null },
};
const CALIB_DEFAULTS = { bleRef: -59, bleTxOffset: -60, wifi24: -30, wifi5: -33, wifi6: -36, sigma: 4 };
const DEFAULTS = {
  env: 'indoor_home', customN: 3.0, view: 'split', range: 'auto', scale: 'log',
  showBle: true, showWifi: true, showUnc: true, showFading: false,
  kind: 'all', state: 'active', trackersOnly: false, sortKey: 'dist', sortDir: 1,
  mapBase: 'osm', mapCenter: null, mapZoom: null, dwell: 120, geoWifi: true, geoBle: false,
  ...CALIB_DEFAULTS,
};

let S = { ...DEFAULTS };
let data = { devices: [], now: Date.now() / 1000, scanner: {}, counts: {}, gap: 120 };
let selectedId = null;
let detail = null;
let hover = null;
let blips = [];
let tableHover = false;
let lastOrder = [];
const disp = new Map(); // id -> animated radius (m)

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
const ago = (s) => (s < 3 ? 'now' : `${fmtDur(s)} ago`);
function fmtTime(ts) {
  const d = new Date(ts * 1000), today = new Date();
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
}
function fmtDist(m) {
  if (m == null || !isFinite(m)) return '—';
  if (m < 1) return `${m.toFixed(1)} m`;
  if (m < 10) return `${m.toFixed(1)} m`;
  return `${Math.round(m)} m`;
}
function hash01(str) { // FNV-1a -> [0,1)
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
const isTracker = (d) => d.tags.includes('tracker');

function displayName(d) {
  if (d.label) return d.label;
  if (d.name) return d.name;
  if (d.kind === 'wifi') return d.meta.bssid ? `Wi-Fi ${d.meta.bssid}` : 'Wi-Fi (name hidden)';
  return d.dtype || 'Unnamed BLE device';
}
function subLine(d) {
  if (d.kind === 'wifi') {
    const parts = [d.meta.bssid || 'BSSID hidden', d.meta.band, d.meta.channel ? `ch ${d.meta.channel}` : null];
    return parts.filter(Boolean).join(' · ');
  }
  return d.id.slice(4, 17) + '…';
}
function typeLine(d) {
  if (d.kind === 'wifi') return [d.dtype, d.meta.security].filter(Boolean).join(' · ');
  return [d.dtype, d.vendor].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ') || 'Bluetooth LE';
}

// ---------- distance model ----------
const pathN = () => (S.env === 'custom' ? +S.customN : ENVS[S.env].n);

function refPower(d) {
  if (d.p1m != null) return { p: d.p1m, src: 'your 1 m calibration' };
  if (d.kind === 'ble') {
    if (d.meta.beacon_p1m != null) return { p: d.meta.beacon_p1m, src: 'beacon’s advertised 1 m power' };
    if (d.meta.tx_power != null) {
      const p = Math.min(-40, Math.max(-80, d.meta.tx_power + +S.bleTxOffset));
      return { p, src: `advertised Tx ${d.meta.tx_power} dBm ${S.bleTxOffset} dB` };
    }
    return { p: +S.bleRef, src: 'Bluetooth default' };
  }
  const band = d.meta.band;
  if (band === '6GHz') return { p: +S.wifi6, src: 'Wi-Fi 6 GHz default' };
  if (band === '5GHz') return { p: +S.wifi5, src: 'Wi-Fi 5 GHz default' };
  return { p: +S.wifi24, src: 'Wi-Fi 2.4 GHz default' };
}

function estimate(d) {
  const n = pathN();
  const { p, src } = refPower(d);
  const r = d.rssi_smooth ?? d.rssi;
  if (r == null) return null;
  const dist = Math.pow(10, (p - r) / (10 * n));
  const sig = Math.sqrt((d.rssi_std || 0) ** 2 + (+S.sigma) ** 2);
  const f = Math.pow(10, sig / (10 * n));
  return { dist, lo: dist / f, hi: dist * f, n, p, src };
}

// ---------- filtering & sorting ----------
function matches(d) {
  if (S.kind !== 'all' && d.kind !== S.kind) return false;
  if (S.trackersOnly && !isTracker(d)) return false;
  const q = $('#search').value.trim().toLowerCase();
  if (q) {
    const hay = [displayName(d), d.name, d.id, d.vendor, d.dtype, d.meta.ssid, d.meta.bssid, ...d.tags].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}
function stateOk(d) {
  if (S.state === 'active') return d.active;
  if (S.state === 'present') return d.present;
  if (S.state === 'recent') return data.now - d.last_seen <= 900;
  return true;
}
const SORTERS = {
  watched: (d) => (d.watched ? 0 : 1),
  name: (d) => displayName(d).toLowerCase(),
  dtype: (d) => typeLine(d).toLowerCase(),
  rssi: (d) => -(d.rssi_smooth ?? -200),
  dist: (d) => (d.active ? (d._est?.dist ?? 1e9) : 1e9 + d.age),
  here: (d) => -d.here_for,
  total: (d) => -d.total_seconds,
  first: (d) => d.first_seen,
  last: (d) => d.age,
};

// ---------- list ----------
function renderList() {
  const rows = data.devices.filter((d) => matches(d) && stateOk(d));
  const key = SORTERS[S.sortKey] || SORTERS.dist;
  rows.sort((a, b) => {
    const x = key(a), y = key(b);
    return (x < y ? -1 : x > y ? 1 : 0) * S.sortDir;
  });
  // While the pointer is over the table, keep rows where they are so they
  // don't jump out from under the cursor; new devices go to the bottom.
  if (tableHover && lastOrder.length) {
    const pos = new Map(lastOrder.map((id, i) => [id, i]));
    rows.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  }
  lastOrder = rows.map((d) => d.id);
  const shown = rows.slice(0, 500);
  $('#count').textContent = `${rows.length} shown · ${data.counts.active ?? 0} active · ${data.counts.total ?? 0} recorded`;
  $$('#tbl th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.k === S.sortKey);
    th.classList.toggle('desc', th.dataset.k === S.sortKey && S.sortDir < 0);
  });
  $('#tbl tbody').innerHTML = shown.map((d) => {
    const e = d._est;
    const trk = isTracker(d);
    const ic = trk ? 'trk' : d.kind;
    const pct = Math.max(0, Math.min(100, ((d.rssi_smooth ?? -100) + 100) / 70 * 100));
    const chips = d.tags.filter((t) => ['tracker', 'separated', 'connected', 'hidden', 'name-hidden', 'hotspot', 'beacon', 'open'].includes(t))
      .map((t) => `<span class="chip ${t}">${esc(t)}</span>`).join('');
    const here = d.present ? `<span class="${d.active ? 'live' : ''}">${fmtDur(d.here_for)}</span>` : '<span class="muted">—</span>';
    return `<tr data-id="${esc(d.id)}" class="${d.id === selectedId ? 'sel' : ''} ${d.active ? '' : 'gone'}">
      <td class="c-star"><span class="star ${d.watched ? 'on' : ''}">★</span></td>
      <td><div class="dname"><span class="ic ${ic}">${d.kind === 'wifi' ? 'W' : 'B'}</span>
        <span class="t"><span class="n">${esc(displayName(d))}${chips}</span><span class="sub">${esc(subLine(d))}</span></span></div></td>
      <td class="c-type">${esc(typeLine(d))}</td>
      <td class="num"><span class="sig"><span class="bar"><i style="width:${pct}%"></i></span>${d.rssi_smooth != null ? Math.round(d.rssi_smooth) + ' dBm' : '—'}</span></td>
      <td class="num dist">${d.active && e ? `~${fmtDist(e.dist)}` : '—'}</td>
      <td class="num">${here}</td>
      <td class="num">${fmtDur(d.total_seconds)}<small class="muted">${d.sessions > 1 ? ` · ${d.sessions}×` : ''}</small></td>
      <td class="num c-first">${fmtTime(d.first_seen)}</td>
      <td class="num">${ago(d.age)}</td></tr>`;
  }).join('');
  const empty = $('#empty');
  empty.hidden = shown.length > 0;
  if (!shown.length) {
    empty.textContent = data.devices.length
      ? 'No devices match these filters.'
      : (data.scanner.online ? 'Scanning… devices will appear here.' : 'Waiting for the scanner app to send data.');
  }
}

// ---------- radar ----------
const NICE = [2, 3, 5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500];
function radarSet() {
  return data.devices.filter((d) => matches(d) && ((d.kind === 'ble' && S.showBle) || (d.kind === 'wifi' && S.showWifi))
    && (d.active || (S.showFading && d.present)) && d._est);
}
function rangeMax(set) {
  if (S.range !== 'auto') return +S.range;
  const ds = set.filter((d) => d.active).map((d) => d._est.dist).sort((a, b) => a - b);
  if (!ds.length) return 10;
  const p90 = ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.9))] * 1.15;
  return NICE.find((v) => v >= p90) || 500;
}
function radFrac(d, max) {
  if (S.scale === 'linear') return Math.min(d / max, 1);
  return Math.min(Math.log10(1 + d) / Math.log10(1 + max), 1);
}
// Distance rings picked in screen space, so zooming in reveals finer rings.
const RING_CAND = [0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500];
function ringValues(max, Rz) {
  const out = [];
  let lastR = -1e9;
  for (const v of RING_CAND) {
    if (v >= max * 0.97) break;
    const r = radFrac(v, max) * Rz;
    if (r >= 14 && r - lastR >= 40) { out.push(v); lastR = r; }
  }
  if (out.length && Rz - lastR < 30) out.pop();
  return [...out, max];
}
function colorFor(d) {
  if (isTracker(d)) return css('--tracker');
  return d.kind === 'wifi' ? css('--wifi') : css('--ble');
}

const canvas = $('#radar');

// ---------- zoom / pan ----------
// view = target, vcur = what is drawn (eased toward view). Pan is in CSS pixels,
// zoom scales the radar around its centre: screen = centre + polar * R * z + pan.
const ZMIN = 1, ZMAX = 30;
const view = { z: 1, px: 0, py: 0 };
const vcur = { z: 1, px: 0, py: 0 };
let geom = { cx: 0, cy: 0, R: 1, size: 0 };
const clampZ = (z) => Math.max(ZMIN, Math.min(ZMAX, z));
function clampPan(v) {
  const lim = geom.R * (v.z - 1);
  const len = Math.hypot(v.px, v.py);
  if (len > lim) { const k = lim / (len || 1); v.px *= k; v.py *= k; }
}
function setView(z, px, py, animate) {
  view.z = clampZ(z); view.px = px; view.py = py;
  if (view.z === 1) { view.px = 0; view.py = 0; }
  clampPan(view);
  if (!animate) Object.assign(vcur, view);
}
function zoomAt(sx, sy, factor, animate) {
  const z1 = clampZ(view.z * factor);
  const k = z1 / view.z;
  // keep the point under (sx, sy) fixed
  setView(z1, sx - geom.cx - (sx - geom.cx - view.px) * k, sy - geom.cy - (sy - geom.cy - view.py) * k, animate);
}
const resetZoom = () => setView(1, 0, 0, true);
function focusDevice(id) {
  const d = data.devices.find((x) => x.id === id);
  if (!d?._est) return;
  const max = rangeMax(radarSet());
  const fr = radFrac(disp.get(id) ?? d._est.dist, max);
  const ang = hash01(id) * Math.PI * 2;
  const z = Math.max(view.z, 4);
  setView(z, -Math.cos(ang) * fr * geom.R * z, -Math.sin(ang) * fr * geom.R * z, true);
}

function drawRadar(tms) {
  const wrap = $('#radarWrap');
  if (wrap.offsetParent === null) { requestAnimationFrame(drawRadar); return; }
  const dpr = window.devicePixelRatio || 1;
  // The canvas fills the panel; the radar disc is sized to the shorter side.
  const W = Math.max(200, Math.floor(wrap.clientWidth - 20)), H = Math.max(200, Math.floor(wrap.clientHeight - 20));
  const size = Math.min(W, H);
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr) || canvas.style.width !== W + 'px') {
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, R = size / 2 - 22;
  geom = { cx, cy, R, W, H };
  for (const k of ['z', 'px', 'py']) {
    vcur[k] += (view[k] - vcur[k]) * 0.22;
    if (Math.abs(view[k] - vcur[k]) < 1e-3) vcur[k] = view[k];
  }
  const z = vcur.z, ox = cx + vcur.px, oy = cy + vcur.py, Rz = R * z;
  const zoomed = z > 1.02;
  const set = radarSet();
  const max = rangeMax(set);
  const line = css('--radar-line'), txt = css('--radar-text'), accent = css('--accent');

  ctx.save();
  if (zoomed) { ctx.beginPath(); ctx.roundRect(0, 0, W, H, 10); ctx.clip(); }
  // disc
  ctx.fillStyle = css('--radar-bg');
  ctx.beginPath(); ctx.arc(ox, oy, Rz, 0, Math.PI * 2); ctx.fill();
  // spokes
  ctx.strokeStyle = line; ctx.lineWidth = 1;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + Math.cos(a) * Rz, oy + Math.sin(a) * Rz); ctx.stroke();
  }
  // rings + labels; labels sit on the ray from the radar centre toward the view centre
  const centreVisible = ox > 0 && ox < W && oy > 0 && oy < H;
  const la = centreVisible ? -Math.PI / 2 + 0.18 : Math.atan2(cy - oy, cx - ox) - 0.12;
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const v of ringValues(max, Rz)) {
    const r = radFrac(v, max) * Rz;
    ctx.beginPath(); ctx.arc(ox, oy, r, 0, Math.PI * 2);
    ctx.strokeStyle = v === max ? 'rgba(52,211,153,.4)' : line; ctx.stroke();
    ctx.fillStyle = txt;
    ctx.fillText(`${v} m`, ox + Math.cos(la) * r + 3, oy + Math.sin(la) * r);
  }
  // sweep
  const sweep = ((tms / 4000) % 1) * Math.PI * 2;
  if (ctx.createConicGradient) {
    const g = ctx.createConicGradient(sweep - Math.PI * 0.5, ox, oy);
    g.addColorStop(0, 'rgba(52,211,153,0)');
    g.addColorStop(0.248, 'rgba(52,211,153,0.16)');
    g.addColorStop(0.25, 'rgba(52,211,153,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(ox, oy, Rz, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(52,211,153,.55)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + Math.cos(sweep) * Rz, oy + Math.sin(sweep) * Rz); ctx.stroke();

  // blip positions first, so density and labels depend on what is on screen
  const items = set.map((d) => {
    const e = d._est;
    const prev = disp.get(d.id) ?? e.dist;
    const cur = prev + (e.dist - prev) * 0.08;
    disp.set(d.id, cur);
    const ang = hash01(d.id) * Math.PI * 2;
    const fr = radFrac(cur, max);
    const x = ox + Math.cos(ang) * fr * Rz, y = oy + Math.sin(ang) * fr * Rz;
    return { d, e, ang, x, y, out: cur > max, onScreen: x > -10 && x < W + 10 && y > -10 && y < H + 10 };
  });
  const visible = items.filter((it) => it.onScreen);
  blips = [];
  const dense = visible.length > 40;
  const labelRects = [];
  // zoomed in: try to label everything on screen (collisions are skipped); otherwise the 6 nearest
  const labelled = new Set((zoomed && z >= 1.5 ? visible : visible.filter((it) => it.d.active)
    .sort((a, b) => a.e.dist - b.e.dist).slice(0, 6)).map((it) => it.d.id));
  const highlighted = (d) => d.id === selectedId || d.id === hover || d.watched || isTracker(d);
  visible.sort((a, b) => (a.d.id === selectedId) - (b.d.id === selectedId) || labelled.has(b.d.id) - labelled.has(a.d.id));
  for (const { d, e, ang, x, y, out } of visible) {
    const col = colorFor(d);
    const fade = d.active ? 1 : Math.max(0.15, 1 - d.age / data.gap);
    const delta = ((sweep - ang) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    const glow = Math.exp(-delta * 1.6);

    if (S.showUnc && d.active && (!dense || d.id === selectedId || d.id === hover)) {
      const r0 = radFrac(Math.min(e.lo, max), max) * Rz, r1 = radFrac(Math.min(e.hi, max), max) * Rz;
      ctx.strokeStyle = col; ctx.globalAlpha = 0.28 * fade; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ox + Math.cos(ang) * r0, oy + Math.sin(ang) * r0);
      ctx.lineTo(ox + Math.cos(ang) * r1, oy + Math.sin(ang) * r1);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
    const rad = (d.kind === 'wifi' ? 4.5 : 4) + (isTracker(d) ? 1.5 : 0) - (dense && !highlighted(d) ? 1.5 : 0);
    ctx.globalAlpha = fade * (dense && !highlighted(d) ? 0.7 : 1);
    if (glow > 0.05 && d.active) {
      ctx.fillStyle = col; ctx.globalAlpha = 0.35 * glow * fade;
      ctx.beginPath(); ctx.arc(x, y, rad + 7 * glow, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = fade;
    }
    ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (d.kind === 'wifi') ctx.rect(x - rad, y - rad, rad * 2, rad * 2);
    else ctx.arc(x, y, rad, 0, Math.PI * 2);
    out || !d.active ? ctx.stroke() : ctx.fill();
    if (d.watched) {
      ctx.strokeStyle = css('--watched'); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, rad + 4, 0, Math.PI * 2); ctx.stroke();
    }
    if (d.id === selectedId) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, rad + 7, 0, Math.PI * 2); ctx.stroke();
    }
    if (labelled.has(d.id) || d.id === selectedId || d.watched || d.id === hover) {
      const nm = displayName(d);
      ctx.font = '11px ui-sans-serif, -apple-system, sans-serif';
      const left = Math.cos(ang) < -0.2 || x > W - 120;
      const text = (nm.length > 20 ? nm.slice(0, 19) + '…' : nm) + `  ${fmtDist(e.dist)}`;
      const w = ctx.measureText(text).width;
      const lx = x + (left ? -(rad + 6) : rad + 6);
      const rect = { x0: left ? lx - w : lx, x1: left ? lx : lx + w, y0: y - 7, y1: y + 7 };
      const forced = d.id === selectedId || d.id === hover;
      const clash = labelRects.some((o) => rect.x0 < o.x1 && rect.x1 > o.x0 && rect.y0 < o.y1 && rect.y1 > o.y0);
      if (forced || !clash) {
        labelRects.push(rect);
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(4,17,13,.75)';
        ctx.fillRect(rect.x0 - 2, rect.y0, rect.x1 - rect.x0 + 4, 14);
        ctx.fillStyle = 'rgba(219,228,240,.92)';
        ctx.textAlign = left ? 'right' : 'left';
        ctx.fillText(text, lx, y);
      }
    }
    ctx.globalAlpha = 1;
    blips.push({ id: d.id, x, y, r: rad + 6 });
  }
  // you
  ctx.fillStyle = accent;
  ctx.beginPath(); ctx.arc(ox, oy, 4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = accent; ctx.globalAlpha = 0.4 + 0.3 * Math.sin(tms / 400);
  ctx.beginPath(); ctx.arc(ox, oy, 9, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
  ctx.fillStyle = txt; ctx.textAlign = 'center'; ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.fillText('YOU', ox, oy + 18);
  ctx.restore();

  if (zoomed && !centreVisible) { // arrow on the edge pointing back to you
    const a = Math.atan2(oy - cy, ox - cx);
    // where the ray toward you leaves the canvas, inset 14px
    const t = Math.min(Math.abs((W / 2 - 14) / (Math.cos(a) || 1e-9)), Math.abs((H / 2 - 14) / (Math.sin(a) || 1e-9)));
    const ex = cx + Math.cos(a) * t, ey = cy + Math.sin(a) * t;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(ex + Math.cos(a) * 7, ey + Math.sin(a) * 7);
    ctx.lineTo(ex + Math.cos(a + 2.4) * 7, ey + Math.sin(a + 2.4) * 7);
    ctx.lineTo(ex + Math.cos(a - 2.4) * 7, ey + Math.sin(a - 2.4) * 7);
    ctx.fill();
  }
  const zl = $('#zoomLevel');
  const ztxt = `${view.z < 10 ? view.z.toFixed(1) : Math.round(view.z)}×`;
  if (zl.textContent !== ztxt) zl.textContent = ztxt;
  $('#zoomOut').disabled = view.z <= ZMIN;
  $('#zoomIn').disabled = view.z >= ZMAX;
  $('#zoomReset').disabled = view.z === 1;
  $('#zoomFocus').disabled = !selectedId || !set.some((d) => d.id === selectedId);
  requestAnimationFrame(drawRadar);
}

function blipAt(ev) {
  const r = canvas.getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top;
  let best = null, bd = 1e9;
  for (const b of blips) {
    const dd = Math.hypot(b.x - x, b.y - y);
    if (dd < b.r + 4 && dd < bd) { best = b; bd = dd; }
  }
  return best;
}
canvas.addEventListener('mousemove', (ev) => {
  const b = blipAt(ev);
  const tip = $('#tip');
  hover = b?.id ?? null;
  canvas.classList.toggle('onblip', !!b);
  canvas.classList.toggle('zoomed', view.z > 1);
  if (!b || gesture?.moved) { tip.hidden = true; return; }
  const d = data.devices.find((x) => x.id === b.id);
  if (!d) return;
  const e = d._est;
  tip.innerHTML = `<b>${esc(displayName(d))}</b><span>${esc(typeLine(d))}</span><br>
    ~${fmtDist(e.dist)} <span>(${fmtDist(e.lo)}–${fmtDist(e.hi)})</span> · ${Math.round(d.rssi_smooth)} dBm<br>
    <span>here for</span> ${fmtDur(d.here_for)}`;
  const wr = $('#radarWrap').getBoundingClientRect();
  tip.style.left = Math.min(ev.clientX - wr.left + 14, wr.width - 270) + 'px';
  tip.style.top = ev.clientY - wr.top + 14 + 'px';
  tip.hidden = false;
});
canvas.addEventListener('mouseleave', () => { $('#tip').hidden = true; hover = null; });

// wheel / trackpad: zoom toward the cursor
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const r = canvas.getBoundingClientRect();
  const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
  zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-dy * 0.0018), false);
}, { passive: false });

// drag to pan, pinch to zoom, tap/click to select
const pointers = new Map();
let gesture = null;
canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  const pts = [...pointers.values()];
  gesture = pts.length === 1
    ? { type: 'pan', sx: ev.clientX, sy: ev.clientY, px: view.px, py: view.py, moved: false }
    : { type: 'pinch', dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), mx: (pts[0].x + pts[1].x) / 2, my: (pts[0].y + pts[1].y) / 2, moved: true };
});
canvas.addEventListener('pointermove', (ev) => {
  if (!pointers.has(ev.pointerId) || !gesture) return;
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  const r = canvas.getBoundingClientRect();
  if (gesture.type === 'pan') {
    const dx = ev.clientX - gesture.sx, dy = ev.clientY - gesture.sy;
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
    gesture.moved = true;
    $('#tip').hidden = true;
    if (view.z > 1) setView(view.z, gesture.px + dx, gesture.py + dy, false);
  } else if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    setView(view.z, view.px + mx - gesture.mx, view.py + my - gesture.my, false);
    zoomAt(mx - r.left, my - r.top, dist / (gesture.dist || dist), false);
    Object.assign(gesture, { dist, mx, my });
  }
  canvas.classList.toggle('grabbing', gesture.type === 'pan' && view.z > 1);
});
function endPointer(ev) {
  if (!pointers.has(ev.pointerId)) return;
  pointers.delete(ev.pointerId);
  if (gesture?.type === 'pan' && !gesture.moved && ev.type === 'pointerup') {
    const b = blipAt(ev);
    if (b) openDetail(b.id);
  }
  canvas.classList.remove('grabbing');
  if (pointers.size === 1) { // pinch -> pan with the remaining finger
    const [p] = [...pointers.values()];
    gesture = { type: 'pan', sx: p.x, sy: p.y, px: view.px, py: view.py, moved: true };
  } else if (!pointers.size) gesture = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('dblclick', (ev) => {
  const r = canvas.getBoundingClientRect();
  zoomAt(ev.clientX - r.left, ev.clientY - r.top, ev.shiftKey ? 0.5 : 2, true);
});
$('#zoomIn').onclick = () => zoomAt(geom.cx, geom.cy, 1.6, true);
$('#zoomOut').onclick = () => zoomAt(geom.cx, geom.cy, 1 / 1.6, true);
$('#zoomReset').onclick = resetZoom;
$('#zoomFocus').onclick = () => selectedId && focusDevice(selectedId);
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (S.view === 'list' || S.view === 'map') return;
  if (e.key === '+' || e.key === '=') zoomAt(geom.cx, geom.cy, 1.6, true);
  else if (e.key === '-' || e.key === '_') zoomAt(geom.cx, geom.cy, 1 / 1.6, true);
  else if (e.key === '0') resetZoom();
  else if (e.key.toLowerCase() === 'f' && selectedId) focusDevice(selectedId);
});

// ---------- detail drawer ----------
function openDetail(id) {
  selectedId = id;
  $('#drawer').hidden = false;
  detail = null;
  $('#dLabel').value = data.devices.find((d) => d.id === id)?.label || '';
  loadDetail();
  renderList();
}
function closeDetail() { selectedId = null; detail = null; $('#drawer').hidden = true; renderList(); }

async function loadDetail() {
  if (!selectedId) return;
  const id = selectedId;
  try {
    const r = await fetch(`/api/device/${encodeURIComponent(id)}?minutes=30`);
    if (!r.ok || id !== selectedId) return;
    detail = await r.json();
    renderDetail();
  } catch (_) { /* server restarting */ }
}

function renderDetail() {
  const d = detail;
  if (!d) return;
  d.age = d.now - d.last_seen;
  const e = estimate(d);
  $('#dKind').textContent = `${d.kind === 'wifi' ? 'Wi-Fi' : 'Bluetooth LE'} · ${typeLine(d)}`;
  $('#dName').textContent = displayName(d);
  $('#dId').textContent = d.kind === 'wifi' ? (d.meta.bssid || d.id) : d.id.slice(4);
  $('#dStats').innerHTML = [
    ['Distance', d.active && e ? `~${fmtDist(e.dist)}` : '—', d.active && e ? `${fmtDist(e.lo)} – ${fmtDist(e.hi)}` : 'not in range'],
    ['Signal', d.rssi_smooth != null ? `${Math.round(d.rssi_smooth)} dBm` : '—', `±${(d.rssi_std || 0).toFixed(1)} dB · max ${d.rssi_max != null ? Math.round(d.rssi_max) : '—'}`],
    ['Here for', d.present ? fmtDur(d.here_for) : '—', d.active ? 'in range now' : `last seen ${ago(d.age)}`],
    ['Total seen', fmtDur(d.total_seconds), `${d.sessions} session${d.sessions === 1 ? '' : 's'}`],
    ['First seen', fmtTime(d.first_seen), ago(d.now - d.first_seen)],
    ['Sightings', d.sightings.toLocaleString(), 'scan batches'],
  ].map(([k, v, s]) => `<div class="stat"><span>${k}</span><b>${esc(v)}</b><br><small>${esc(s)}</small></div>`).join('');
  $('#dTags').innerHTML = d.tags.map((t) => `<span class="chip ${esc(t)}">${esc(t)}</span>`).join('');
  $('#dRef').innerHTML = e
    ? `Using P<sub>1m</sub> = ${Math.round(e.p)} dBm (${esc(e.src)}) and n = ${e.n.toFixed(1)} (${esc(S.env === 'custom' ? 'custom' : ENVS[S.env].label)}).`
    : '';
  $('#dCalReset').hidden = d.p1m == null;
  $('#dWatch').textContent = d.watched ? '★ Watching' : '☆ Watch';
  $('#dWatch').classList.toggle('on', d.watched);
  if (document.activeElement !== $('#dLabel')) $('#dLabel').value = d.label || '';

  const m = d.meta;
  const kv = d.kind === 'wifi'
    ? [['SSID', m.ssid ?? '(hidden by macOS — needs Location)'], ['BSSID', m.bssid], ['Band', m.band], ['Channel', m.channel ? `${m.channel}${m.width ? ` (${m.width})` : ''}` : null],
       ['Security', m.security], ['Noise', m.noise != null ? `${m.noise} dBm` : null], ['Country', m.country], ['Connected', m.connected ? 'yes' : null]]
    : [['Advertised name', d.name], ['Vendor', d.vendor], ['Apple types', m.apple?.join(', ')], ['Tx power', m.tx_power != null ? `${m.tx_power} dBm` : null],
       ['Services', m.services?.join(', ')], ['Manufacturer data', m.mfg], ['Connectable', m.connectable == null ? null : (m.connectable ? 'yes' : 'no')],
       ['Note', 'Bluetooth IDs are per-Mac identifiers. Phones and AirTags rotate their address every ~15 min, so they may reappear as new devices.']];
  $('#dMeta').innerHTML = kv.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('#dSessions tbody').innerHTML = d.session_list.map((s) =>
    `<tr><td>${fmtTime(s.start)}</td><td class="num">${fmtDur(s.end - s.start)}</td><td class="num">${s.max_rssi != null ? Math.round(s.max_rssi) + ' dBm' : '—'}</td></tr>`).join('');
  drawChart(d);
}

function drawChart(d) {
  const c = $('#dChart');
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = 150;
  c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t1 = d.now, t0 = t1 - 1800, lo = -100, hi = -20;
  const X = (t) => 34 + ((t - t0) / (t1 - t0)) * (W - 44);
  const Y = (r) => 10 + ((hi - r) / (hi - lo)) * (H - 30);
  ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.fillStyle = css('--radar-text'); ctx.strokeStyle = css('--radar-line');
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let r = -100; r <= -20; r += 20) {
    ctx.beginPath(); ctx.moveTo(34, Y(r)); ctx.lineTo(W - 10, Y(r)); ctx.stroke();
    ctx.fillText(String(r), 30, Y(r));
  }
  ctx.textAlign = 'center';
  for (let m = 30; m >= 0; m -= 10) ctx.fillText(m ? `-${m}m` : 'now', X(t1 - m * 60), H - 8);
  const pts = d.history.filter(([t]) => t >= t0);
  if (!pts.length) return;
  ctx.strokeStyle = colorFor(d); ctx.lineWidth = 1.5; ctx.beginPath();
  pts.forEach(([t, r], i) => {
    const x = X(t), y = Y(Math.max(lo, Math.min(hi, r)));
    // break the line across gaps longer than a minute
    if (i === 0 || t - pts[i - 1][0] > 60) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = colorFor(d);
  for (const [t, r] of pts) { ctx.beginPath(); ctx.arc(X(t), Y(Math.max(lo, Math.min(hi, r))), 1.5, 0, Math.PI * 2); ctx.fill(); }
}

async function patchDevice(body) {
  if (!selectedId) return;
  await fetch(`/api/device/${encodeURIComponent(selectedId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  await poll(); await loadDetail();
}
$('#dClose').onclick = closeDetail;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#calib').open) closeDetail(); });
$('#dCal').onclick = () => {
  const d = detail || data.devices.find((x) => x.id === selectedId);
  if (d?.rssi_smooth != null && d.active) patchDevice({ p1m: Math.round(d.rssi_smooth) });
};
$('#dCalReset').onclick = () => patchDevice({ p1m: null });
$('#dWatch').onclick = () => patchDevice({ watched: !(detail?.watched) });
$('#dLabel').addEventListener('change', (e) => patchDevice({ label: e.target.value }));
$('#dLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

// ---------- status ----------
function renderStatus() {
  const s = data.scanner || {};
  const st = s.status || {};
  const pills = [];
  const demo = s.source === 'demo';
  pills.push(demo ? ['warn', 'Source', 'demo data'] : s.online ? ['ok', 'Scanner', 'live'] : ['bad', 'Scanner', 'offline']);
  const bt = st.bluetooth || 'unknown';
  pills.push([bt === 'poweredOn' ? 'ok' : 'bad', 'Bluetooth', bt === 'poweredOn' ? 'scanning' : bt]);
  const loc = st.location || 'unknown';
  pills.push([loc === 'authorized' ? 'ok' : 'warn', 'Wi-Fi names', loc === 'authorized' ? 'visible' : 'hidden']);
  if (s.wifi_scan) pills.push(['', 'Wi-Fi scan', ago(data.now - s.wifi_scan)]);
  pills.push(['', 'Active', String(data.counts.active ?? 0)]);
  $('#pills').innerHTML = pills.map(([c, k, v]) => `<span class="pill ${c}"><i></i>${esc(k)} <b>${esc(v)}</b></span>`).join('');

  const b = [];
  if (!s.online && !demo) {
    b.push(['bad', s.last_post
      ? `Scanner stopped sending data ${ago(data.now - s.last_post)}. Restart it with <code>./run.sh</code> or <code>open build/StealtherScanner.app</code>.`
      : 'Waiting for the scanner. Start everything with <code>./run.sh</code>; macOS will ask to allow Bluetooth and Location for “Stealther Scanner”.']);
  }
  if (s.online && loc !== 'authorized') {
    b.push(['', 'macOS hides Wi-Fi names and BSSIDs from apps without Location access, so networks are grouped by channel. Allow <b>Stealther Scanner</b> in System Settings → Privacy &amp; Security → Location Services. (Your position is never read.)']);
  }
  if (s.online && ['unauthorized', 'poweredOff'].includes(bt)) {
    b.push(['bad', bt === 'poweredOff' ? 'Bluetooth is turned off.' : 'Bluetooth access denied: allow <b>Stealther Scanner</b> in System Settings → Privacy &amp; Security → Bluetooth.']);
  }
  if (st.wifi_error && s.online) b.push(['', `Wi-Fi scan error: ${esc(st.wifi_error)}`]);
  const trk = data.devices.filter((d) => d.active && d.tags.includes('separated') && d.here_for > 600);
  if (trk.length) {
    b.push(['bad', `${trk.length} tracker${trk.length > 1 ? 's' : ''} separated from ${trk.length > 1 ? 'their owners have' : 'its owner has'} been near you for over 10 minutes: ${trk.map((d) => `<b>${esc(displayName(d))}</b> (${fmtDur(d.here_for)})`).join(', ')}.`]);
  }
  const html = b.map(([c, t]) => `<div class="banner ${c}">${t}</div>`).join('');
  if ($('#banners').innerHTML !== html) $('#banners').innerHTML = html;

  $('#radarNote').innerHTML = `Distance is a best guess from signal strength (n = ${pathN().toFixed(1)}, ${esc(S.env === 'custom' ? 'custom' : ENVS[S.env].label)}). ` +
    'A single Mac antenna can’t measure direction, so each device keeps a fixed bearing from its ID; only the distance from the centre is meaningful. ' +
    'Scroll or pinch to zoom, drag to pan, double-click to zoom in (shift: out), <kbd>F</kbd> to focus the selected device, <kbd>0</kbd> to reset. ' +
    '<span style="color:var(--ble)">●</span> Bluetooth <span style="color:var(--wifi)">■</span> Wi-Fi <span style="color:var(--tracker)">●</span> tracker.';
}

// ---------- polling ----------
async function poll() {
  try {
    const r = await fetch(`/api/devices?since=${S.state === 'all' ? 0 : 900}`);
    data = await r.json();
    for (const d of data.devices) d._est = estimate(d);
    renderStatus();
    renderList();
  } catch (_) {
    $('#pills').innerHTML = '<span class="pill bad"><i></i>Server <b>unreachable</b></span>';
  }
}

// ---------- settings ----------
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ui: S }),
  }).catch(() => {}), 400);
}
function recompute() {
  for (const d of data.devices) d._est = estimate(d);
  renderStatus(); renderList(); renderDetail();
  if (typeof geoRecompute === 'function') geoRecompute();
}

function applyControls() {
  $('#env').value = S.env;
  $('#customNWrap').hidden = S.env !== 'custom';
  $('#customN').value = S.customN; $('#customNOut').textContent = (+S.customN).toFixed(1);
  $('#main').className = S.view;
  $$('#view button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.view));
  $$('#kind button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.kind));
  $('#range').value = S.range; $('#scale').value = S.scale; $('#state').value = S.state;
  for (const k of ['showBle', 'showWifi', 'showUnc', 'showFading', 'trackersOnly']) $('#' + k).checked = !!S[k];
  for (const k of Object.keys(CALIB_DEFAULTS)) $('#' + k).value = S[k];
  if (typeof geoApply === 'function') geoApply(); // geo.js loads after this file
}
function set(k, v) { S[k] = v; applyControls(); saveSettings(); recompute(); }

$('#env').innerHTML = Object.entries(ENVS).map(([k, v]) => `<option value="${k}">${esc(v.label)}${v.n ? ` (n ${v.n})` : ''}</option>`).join('');
$('#env').onchange = (e) => set('env', e.target.value);
$('#customN').oninput = (e) => set('customN', +e.target.value);
$$('#view button').forEach((b) => (b.onclick = () => set('view', b.dataset.v)));
$$('#kind button').forEach((b) => (b.onclick = () => set('kind', b.dataset.v)));
$('#range').onchange = (e) => set('range', e.target.value);
$('#scale').onchange = (e) => set('scale', e.target.value);
$('#state').onchange = (e) => { set('state', e.target.value); poll(); };
for (const k of ['showBle', 'showWifi', 'showUnc', 'showFading', 'trackersOnly']) $('#' + k).onchange = (e) => set(k, e.target.checked);
$('#search').oninput = () => renderList();
$$('#tbl th').forEach((th) => (th.onclick = () => {
  const k = th.dataset.k;
  if (S.sortKey === k) S.sortDir = -S.sortDir; else { S.sortKey = k; S.sortDir = 1; }
  saveSettings(); renderList();
}));
// pointerdown, not click: the table re-renders every second, which would
// swallow a click whose mousedown and mouseup land on different nodes.
$('#tbl tbody').addEventListener('pointerdown', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr && e.button === 0) openDetail(tr.dataset.id);
});
$('#tbl tbody').addEventListener('pointerenter', () => { tableHover = true; });
$('#tbl tbody').addEventListener('pointerleave', () => { tableHover = false; });
$('#calibBtn').onclick = () => $('#calib').showModal();
for (const k of Object.keys(CALIB_DEFAULTS)) $('#' + k).addEventListener('input', (e) => {
  if (e.target.value !== '' && isFinite(+e.target.value)) { S[k] = +e.target.value; saveSettings(); recompute(); }
});
$('#calibReset').onclick = (e) => { e.preventDefault(); Object.assign(S, CALIB_DEFAULTS); applyControls(); saveSettings(); recompute(); };

(async function init() {
  try {
    const st = await (await fetch('/api/settings')).json();
    if (st.ui) S = { ...DEFAULTS, ...st.ui };
    if (!ENVS[S.env]) S.env = DEFAULTS.env;
  } catch (_) { /* defaults */ }
  applyControls();
  await poll();
  setInterval(poll, 1000);
  setInterval(loadDetail, 2000);
  requestAnimationFrame(drawRadar);
})();
