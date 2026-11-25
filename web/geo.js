'use strict';
// Map view: you mark where you stand (and when), the server returns each
// device's median RSSI at every spot, and this file fits a position for each
// device with the same log-distance model the radar uses.
//
// For every cell of a grid around your spots it asks: if the device were here,
// how well would  RSSI_i = P - 10·n·log10(d_i)  explain what each spot heard?
// P (the 1 m power) is solved per cell, pulled toward the usual default. Spots
// where the device should have been loud but wasn't heard count against the
// cell too. The best cell is the estimate; the spread of good cells is its
// uncertainty. Spots in a straight line can't tell the two sides apart, so
// those devices get two mirror-image candidates.

const GEO_SIGMA = 6;       // dB: spot-to-spot error of a median RSSI (shadowing, bodies, walls)
const GEO_P_SIGMA = 6;     // dB: how far the device's 1 m power may stray from the default
const GEO_MISS_DBM = -85;  // a device predicted louder than this should have been heard
const GEO_GRID = 120;      // grid cells per side
const ANT_H = 1;           // m: height offset so the distance never reaches zero

let geoData = { now: 0, fixes: [], devices: [] };
let geoRes = new Map();
let geoSel = null;
let geoSig = '';
let geoClock = 0;          // server time minus local time
let map = null;
let armed = null;          // 'here' | 'past' | null
let pastLatLng = null;
let editFix = null;
const L_ = {};             // map layers

// ---------- helpers ----------
function enu(lat0, lon0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  return {
    fwd: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    inv: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}
const geoNow = () => Date.now() / 1000 + geoClock;
function toLocalInput(ts) {
  const d = new Date(ts * 1000);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fromLocalInput = (s) => (s ? new Date(s).getTime() / 1000 : null);
const fixEnd = (f) => (f.t1 == null ? geoData.now : Math.min(f.t1, geoData.now));
function fixLabel(f) {
  const end = f.t1 == null ? null : f.t1;
  return `${fmtTime(f.t0)}${end ? ` – ${new Date(end * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ' – now'}`;
}
async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// ---------- solver ----------
function solveDevice(d, fixes, fixById, proj) {
  const n = pathN();
  const P0 = refPower(d).p;
  const spots = [];
  for (const [fid, r, cnt] of d.obs) {
    const f = fixById.get(fid);
    if (!f) continue;
    const [x, y] = proj.fwd(f.lat, f.lon);
    spots.push({ fid, x, y, r, cnt, w: 1 / (GEO_SIGMA ** 2 + 14 / cnt) });
  }
  if (!spots.length) return null;
  // Spots where the scanner was clearly working but never heard this device,
  // while the device existed (Bluetooth addresses rotate, so only its lifetime counts).
  const heardAt = new Set(spots.map((s) => s.fid));
  const misses = [];
  for (const f of fixes) {
    if (heardAt.has(f.id) || !(f.heard?.[d.kind] > 0)) continue;
    if (fixEnd(f) - f.t0 < (d.kind === 'wifi' ? 40 : 20)) continue;
    if (fixEnd(f) < d.first_seen || f.t0 > d.last_seen) continue;
    const [x, y] = proj.fwd(f.lat, f.lon);
    misses.push({ fid: f.id, x, y });
  }
  const uniq = [];
  for (const s of spots) if (!uniq.some((u) => Math.hypot(u.x - s.x, u.y - s.y) < 2)) uniq.push(s);
  const best = spots.reduce((a, b) => (b.r > a.r ? b : a));
  const rangeOf = (P, s) => Math.pow(10, (P - s.r) / (10 * n));
  const base = { d, spots, misses, P0, n, best, uniq: uniq.length, rangeOf };
  if (uniq.length < 2) return { ...base, type: 'range', P: P0, x: best.x, y: best.y, dist: rangeOf(P0, best) };

  // grid around the spots, big enough to hold the farthest plausible position
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, dmax = 0;
  for (const s of spots) {
    xmin = Math.min(xmin, s.x); xmax = Math.max(xmax, s.x); ymin = Math.min(ymin, s.y); ymax = Math.max(ymax, s.y);
    dmax = Math.max(dmax, rangeOf(P0, s));
  }
  const margin = Math.max(25, Math.min(400, dmax * 1.3));
  const half = Math.max(xmax - xmin, ymax - ymin) / 2 + margin;
  const cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
  const N = GEO_GRID, cell = (2 * half) / N, x0 = cx - half, y0 = cy - half;
  const cost = new Float32Array(N * N);
  const wP = 1 / GEO_P_SIGMA ** 2;
  const K = spots.length, a = new Float64Array(K);
  let cmin = Infinity, imin = 0;
  for (let j = 0; j < N; j++) {
    const y = y0 + (j + 0.5) * cell;
    for (let i = 0; i < N; i++) {
      const x = x0 + (i + 0.5) * cell;
      let sw = wP, swa = wP * P0;
      for (let k = 0; k < K; k++) {
        const s = spots[k];
        a[k] = s.r + 10 * n * Math.log10(Math.hypot(x - s.x, y - s.y, ANT_H));
        sw += s.w; swa += s.w * a[k];
      }
      const P = swa / sw;
      let c = wP * (P - P0) ** 2;
      for (let k = 0; k < K; k++) c += spots[k].w * (a[k] - P) ** 2;
      for (const m of misses) {
        const pred = P - 10 * n * Math.log10(Math.hypot(x - m.x, y - m.y, ANT_H));
        if (pred > GEO_MISS_DBM) c += ((pred - GEO_MISS_DBM) / GEO_SIGMA) ** 2;
      }
      const idx = j * N + i;
      cost[idx] = c;
      if (c < cmin) { cmin = c; imin = idx; }
    }
  }
  const cellXY = (idx) => [x0 + ((idx % N) + 0.5) * cell, y0 + (Math.floor(idx / N) + 0.5) * cell];

  // Which side of the line through the spots is the device on? With spots in a
  // line both sides fit equally well.
  let mx = 0, my = 0;
  for (const s of uniq) { mx += s.x; my += s.y; }
  mx /= uniq.length; my /= uniq.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const s of uniq) { sxx += (s.x - mx) ** 2; syy += (s.y - my) ** 2; sxy += (s.x - mx) * (s.y - my); }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const vx = -Math.sin(th), vy = Math.cos(th); // normal to the spots' main axis
  const [bx, by] = cellXY(imin);
  const side0 = Math.sign((bx - mx) * vx + (by - my) * vy) || 1;
  let cOther = Infinity, iOther = -1;
  for (let idx = 0; idx < N * N; idx++) {
    const [x, y] = cellXY(idx);
    if (Math.sign((x - mx) * vx + (y - my) * vy) === -side0 && cost[idx] < cOther) { cOther = cost[idx]; iOther = idx; }
  }
  const [ox, oy] = iOther >= 0 ? cellXY(iOther) : [bx, by];
  // spread of the spots across vs along their main axis
  const sAlong = Math.abs(sxx * Math.cos(th) ** 2 + 2 * sxy * Math.sin(th) * Math.cos(th) + syy * Math.sin(th) ** 2) / uniq.length;
  const sAcross = Math.abs(sxx * vx * vx + 2 * sxy * vx * vy + syy * vy * vy) / uniq.length;
  const inLine = Math.sqrt(sAcross) < Math.max(4, 0.25 * Math.sqrt(sAlong));
  const ambiguous = inLine && cOther - cmin < 2 && Math.hypot(ox - bx, oy - by) > Math.max(6, 4 * cell);

  // Likely region: cells whose fit is within chi²(2 dof, 68%) = 2.30 of the best
  // (one side only when ambiguous), i.e. about a 2-in-3 chance. Its shape gives
  // the ellipse, its area the "±" radius. Weighting the whole grid instead lets
  // the far tails dominate.
  let W = 0, ex = 0, ey = 0, exx = 0, eyy = 0, exy = 0;
  for (let idx = 0; idx < N * N; idx++) {
    if (cost[idx] - cmin > 2.3) continue;
    const [x, y] = cellXY(idx);
    if (ambiguous && Math.sign((x - mx) * vx + (y - my) * vy) !== side0) continue;
    W++; ex += x; ey += y; exx += x * x; eyy += y * y; exy += x * y;
  }
  ex /= W; ey /= W;
  const c2 = cell * cell / 12;
  const cov = [exx / W - ex * ex + c2, exy / W - ex * ey, eyy / W - ey * ey + c2];
  const area = W * cell * cell;
  const det = Math.max(1e-6, cov[0] * cov[2] - cov[1] ** 2);
  const kReg = Math.sqrt(area / (Math.PI * Math.sqrt(det))); // ellipse with the region's area
  // P that best fits at the estimate, for the per-spot range circles
  let sw = wP, swa = wP * P0;
  for (const s of spots) { const ak = s.r + 10 * n * Math.log10(Math.hypot(bx - s.x, by - s.y, ANT_H)); sw += s.w; swa += s.w * ak; }
  return {
    ...base, type: ambiguous ? 'amb' : 'fix', x: bx, y: by, ox, oy, mx: ex, my: ey, cov,
    radius: Math.sqrt(area / Math.PI), kReg, P: swa / sw, grid: { cost, cmin, N, cell, x0, y0 },
  };
}

function geoSolveAll() {
  const fixes = geoData.fixes;
  geoRes = new Map();
  if (!fixes.length) return;
  const lat0 = fixes.reduce((s, f) => s + f.lat, 0) / fixes.length;
  const lon0 = fixes.reduce((s, f) => s + f.lon, 0) / fixes.length;
  const proj = enu(lat0, lon0);
  const fixById = new Map(fixes.map((f) => [f.id, f]));
  for (const d of geoData.devices) {
    if (!geoShown(d)) continue;
    const r = solveDevice(d, fixes, fixById, proj);
    if (r) { r.proj = proj; geoRes.set(d.id, r); }
  }
}
const geoShown = (d) => (d.kind === 'wifi' ? S.geoWifi : S.geoBle);

// ---------- map ----------
function geoInit() {
  if (map) return true;
  if (typeof L === 'undefined') {
    const m = $('#mapMsg');
    m.hidden = false;
    m.innerHTML = 'The map library didn’t load. The base map needs an internet connection (Leaflet from unpkg, tiles from OpenStreetMap / Esri).';
    return false;
  }
  map = L.map('map', { zoomControl: true, maxZoom: 21, worldCopyJump: true, attributionControl: true });
  L_.osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxNativeZoom: 19, maxZoom: 21, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  L_.sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 19, maxZoom: 21, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  });
  L_.devs = L.layerGroup().addTo(map);
  L_.sel = L.layerGroup().addTo(map);
  L_.fixes = L.layerGroup().addTo(map);
  L_.temp = L.layerGroup().addTo(map);
  if (S.mapCenter) map.setView(S.mapCenter, S.mapZoom || 18);
  else map.setView([20, 0], 2);
  setBase();
  map.on('moveend', () => {
    const c = map.getCenter();
    S.mapCenter = [+c.lat.toFixed(6), +c.lng.toFixed(6)]; S.mapZoom = map.getZoom();
    saveSettings();
  });
  map.on('click', onMapClick);
  return true;
}
function setBase() {
  if (!map) return;
  const want = S.mapBase === 'sat' ? L_.sat : L_.osm;
  for (const l of [L_.osm, L_.sat]) if (l !== want && map.hasLayer(l)) map.removeLayer(l);
  if (!map.hasLayer(want)) want.addTo(map).bringToBack();
}

function geoApply() {
  $$('#mapBase button').forEach((b) => b.classList.toggle('on', b.dataset.v === (S.mapBase || 'osm')));
  $('#geoWifi').checked = !!S.geoWifi; $('#geoBle').checked = !!S.geoBle;
  $('#dwell').value = String(S.dwell ?? 120);
  if (cand) renderCandBar();
  if (S.view !== 'map') return;
  if (!geoInit()) return;
  setBase();
  setTimeout(() => map.invalidateSize(), 0);
  geoPoll();
}

function setArmed(a) {
  armed = armed === a ? null : a;
  $('#hereBtn').classList.toggle('armed', armed === 'here');
  $('#pastBtn').classList.toggle('armed', armed === 'past');
  $('#map').classList.toggle('placing', !!armed);
  renderMapNote();
}

async function onMapClick(e) {
  if (cand) { cand.marker.setLatLng(e.latlng); candMoved(); return; }
  if (!armed) {
    if (geoSel) { geoSel = null; geoRender(); }
    return;
  }
  const { lat, lng } = e.latlng;
  if (armed === 'here') {
    setArmed(null);
    const dwell = +S.dwell;
    try {
      await api('/api/fixes', { lat, lon: lng, dwell: dwell > 0 ? dwell : null });
    } catch (err) { alert(`Couldn’t save the spot: ${err.message}`); }
    geoSig = ''; geoPoll();
  } else {
    setArmed(null);
    pastLatLng = [lat, lng];
    L_.temp.clearLayers();
    L.marker(pastLatLng, { icon: pinIcon('?', false) }).addTo(L_.temp);
    const now = geoNow();
    $('#pastFrom').value = toLocalInput(now - 600);
    $('#pastTo').value = toLocalInput(now);
    $('#pastForm').hidden = false;
  }
}

// ---------- "find my location" pin ----------
// The browser's position is only approximate (often tens of metres off), so it
// drops a pin you drag to the exact spot and then confirm.
let cand = null; // { marker, circle, acc, moved, why }

function showCand(latlng, acc, why) {
  clearCand();
  setArmed(null);
  const marker = L.marker(latlng, { icon: L.divIcon({ className: '', html: '<div class="candPin"><span>You</span></div>', iconSize: [40, 52], iconAnchor: [20, 50] }), draggable: true, autoPan: true, zIndexOffset: 2000, keyboard: false })
    .addTo(L_.temp);
  const circle = acc ? L.circle(latlng, { radius: acc, color: '#a78bfa', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(L_.temp) : null;
  marker.on('drag', candMoved);
  cand = { marker, circle, acc, moved: false, why };
  $('#map').classList.add('placing');
  renderCandBar();
}
function candMoved() { if (cand) { cand.moved = true; renderCandBar(); } }
function clearCand() {
  if (!cand) return;
  L_.temp.removeLayer(cand.marker);
  if (cand.circle) L_.temp.removeLayer(cand.circle);
  cand = null;
  $('#map').classList.toggle('placing', !!armed);
  renderCandBar();
}
function renderCandBar() {
  const bar = $('#candBar');
  if (bar.hidden !== !cand) { bar.hidden = !cand; map?.invalidateSize({ pan: false }); }
  if (!cand) return;
  const p = cand.marker.getLatLng();
  const dwell = +S.dwell;
  const head = cand.why
    ? `Couldn’t get your location (${esc(cand.why)}), so the pin is at the map centre.`
    : cand.moved ? 'Pin moved.' : `This browser places you here${cand.acc ? `, give or take ${fmtDist(cand.acc)} (purple circle)` : ''}.`;
  $('#candText').innerHTML = `<b>${head}</b> Drag the pin, or click the map, to exactly where you and the Mac are, then confirm. <span class="mono muted">${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</span>`;
  $('#candOk').textContent = `Confirm & record ${dwell > 0 ? fmtDur(dwell).replace(' 00s', '') : 'until I stop'}`;
}
async function confirmCand() {
  if (!cand) return;
  const p = cand.marker.getLatLng();
  const dwell = +S.dwell;
  try {
    await api('/api/fixes', { lat: p.lat, lon: p.lng, dwell: dwell > 0 ? dwell : null });
  } catch (err) { alert(`Couldn’t save the spot: ${err.message}`); return; }
  clearCand();
  geoSig = ''; geoPoll();
}

function pinIcon(label, rec) {
  return L.divIcon({ className: '', html: `<div class="fixPin ${rec ? 'rec' : ''}">${esc(label)}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
}

function ellipse(proj, cx, cy, cov, k) {
  const [a, b, c] = cov;
  const tr = a + c, det = a * c - b * b, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  const th = 0.5 * Math.atan2(2 * b, a - c);
  const pts = [];
  for (let t = 0; t < 48; t++) {
    const u = (t / 48) * 2 * Math.PI;
    const ex = k * Math.sqrt(l1) * Math.cos(u), ey = k * Math.sqrt(l2) * Math.sin(u);
    pts.push(proj.inv(cx + ex * Math.cos(th) - ey * Math.sin(th), cy + ex * Math.sin(th) + ey * Math.cos(th)));
  }
  return pts;
}

function heatImage(r) {
  const { cost, cmin, N } = r.grid;
  const cv = document.createElement('canvas');
  cv.width = N; cv.height = N;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(N, N);
  const rgb = r.d.kind === 'wifi' ? [245, 165, 36] : [56, 189, 248];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const l = Math.exp(-(cost[j * N + i] - cmin) / 2);
    const o = ((N - 1 - j) * N + i) * 4; // canvas row 0 is north
    img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2];
    img.data[o + 3] = Math.round(Math.sqrt(l) * 150);
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL();
}

function devTitle(d) { return displayName(d); }
function qualityText(r) {
  if (r.type === 'range') return { cls: 'rng', t: `~${fmtDist(r.dist)} from spot ${fixNo(r.best.fid)}`, long: `Heard at one place only, so it’s somewhere about ${fmtDist(r.dist)} from spot ${fixNo(r.best.fid)}. Record at more spots to pin it down.` };
  if (r.type === 'amb') return { cls: 'amb', t: '2 possible places', long: 'Your spots are roughly in a line, so the device could be on either side of it (both shown). Add a spot off that line to decide.' };
  return { cls: 'good', t: `±${fmtDist(r.radius)}`, long: `Probably inside the dashed outline, about ±${fmtDist(r.radius)} (a 2-in-3 chance), from ${r.uniq} spots. The shading shows everywhere it could be.` };
}
let fixNoMap = new Map();
const fixNo = (fid) => fixNoMap.get(fid) ?? '?';

function geoRender() {
  if (!map) return;
  const fixes = geoData.fixes;
  fixNoMap = new Map(fixes.map((f, i) => [f.id, i + 1]));
  // spots
  L_.fixes.clearLayers();
  for (const f of fixes) {
    const no = fixNo(f.id);
    const m = L.marker([f.lat, f.lon], { icon: pinIcon(no, f.open), draggable: true, zIndexOffset: 1000, keyboard: false })
      .bindTooltip(`Spot ${no} · ${fixLabel(f)}`, { className: 'devtip', direction: 'top', offset: [0, -14] });
    m.on('dragend', async () => {
      const p = m.getLatLng();
      try { await api(`/api/fix/${f.id}`, { lat: p.lat, lon: p.lng }); } catch (err) { alert(err.message); }
      geoSig = ''; geoPoll();
    });
    m.on('click', () => { editFix = f.id; renderFixList(); });
    m.addTo(L_.fixes);
  }
  // devices
  L_.devs.clearLayers();
  for (const r of geoRes.values()) {
    if (r.type === 'range') continue;
    const col = colorFor(r.d);
    const sel = r.d.id === geoSel;
    const pt = r.proj.inv(r.x, r.y);
    const mk = L.circleMarker(pt, { bubblingMouseEvents: false, radius: sel ? 8 : 6, color: sel ? '#fff' : col, weight: sel ? 2 : 1, fillColor: col, fillOpacity: r.type === 'amb' ? 0.35 : 0.85 })
      .bindTooltip(esc(devTitle(r.d)), { className: 'devtip', direction: 'right', offset: [8, 0], permanent: sel });
    mk.on('click', () => selectGeo(r.d.id, false));
    mk.addTo(L_.devs);
    if (r.type === 'amb') {
      const alt = r.proj.inv(r.ox, r.oy);
      L.polyline([pt, alt], { color: col, weight: 1, dashArray: '3 5', opacity: 0.7, interactive: false }).addTo(L_.devs);
      L.circleMarker(alt, { bubblingMouseEvents: false, radius: sel ? 8 : 6, color: col, weight: 1, fillColor: col, fillOpacity: 0.35 })
        .on('click', () => selectGeo(r.d.id, false)).addTo(L_.devs);
    }
  }
  renderSel();
  renderCard();
  renderFixList();
  renderGeoList();
  renderRecBar();
  renderMapNote();
}

function renderSel() {
  L_.sel.clearLayers();
  const r = geoSel && geoRes.get(geoSel);
  if (!r || !map) return;
  const col = colorFor(r.d);
  if (r.grid) {
    const { N, cell, x0, y0 } = r.grid;
    const sw = r.proj.inv(x0, y0), ne = r.proj.inv(x0 + N * cell, y0 + N * cell);
    L.imageOverlay(heatImage(r), [sw, ne], { opacity: 1, interactive: false }).addTo(L_.sel);
    L.polygon(ellipse(r.proj, r.mx, r.my, r.cov, r.kReg), { color: col, weight: 1.5, fill: false, dashArray: '4 4', interactive: false }).addTo(L_.sel);
  }
  // how far each spot thinks the device is
  for (const s of r.spots) {
    L.circle(r.proj.inv(s.x, s.y), { radius: r.rangeOf(r.P, s), color: col, weight: 1, opacity: 0.6, fill: false, interactive: false }).addTo(L_.sel);
  }
  if (r.type === 'range') {
    L.circleMarker(r.proj.inv(r.x, r.y), { radius: 0, opacity: 0, interactive: false })
      .bindTooltip(esc(displayName(r.d)), { className: 'devtip', permanent: true, direction: 'top' }).addTo(L_.sel);
  }
}

function renderCard() {
  const card = $('#geoCard');
  const r = geoSel && geoRes.get(geoSel);
  if (!r) { card.hidden = true; return; }
  const d = r.d, q = qualityText(r), at = r.proj.inv(r.x, r.y);
  const sub = d.kind === 'wifi' ? [d.meta.ssid ? null : d.meta.bssid, d.meta.band, d.meta.channel && `ch ${d.meta.channel}`, d.meta.security].filter(Boolean).join(' · ') : typeLine(d);
  const rows = r.spots.map((s) => `<tr><td>Spot ${fixNo(s.fid)}</td><td class="num">${Math.round(s.r)} dBm</td><td class="num">~${fmtDist(r.rangeOf(r.P, s))}</td><td class="num muted">${s.cnt}×</td></tr>`).join('')
    + r.misses.map((m) => `<tr class="muted"><td>Spot ${fixNo(m.fid)}</td><td class="num">not heard</td><td></td><td></td></tr>`).join('');
  card.hidden = false;
  card.innerHTML = `<div class="ch"><span class="t"><b>${esc(displayName(d))}</b><span class="sub">${esc(d.kind === 'wifi' && d.meta.bssid ? d.meta.bssid : d.id.slice(4, 17))}${sub ? ` · ${esc(sub)}` : ''}</span></span>
      <button class="btn icon" data-act="close" aria-label="Close">✕</button></div>
    <p class="q ${q.cls}">${esc(q.long)}</p>
    <table class="mini"><thead><tr><th>Heard at</th><th class="num">Signal</th><th class="num">Range</th><th class="num">Readings</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">${r.type === 'range' ? '' : `<span class="mono">${at[0].toFixed(6)}, ${at[1].toFixed(6)}</span> · `}fitted P<sub>1m</sub> ${Math.round(r.P)} dBm (default ${Math.round(r.P0)}) · n ${r.n.toFixed(1)}</p>
    <div class="row">${r.type === 'range' ? '' : '<button class="btn" data-act="copy">Copy coordinates</button>'}<button class="btn" data-act="detail">Device details</button></div>`;
}

function selectGeo(id, pan) {
  geoSel = geoSel === id && !pan ? null : id;
  geoRender();
  const r = geoSel && geoRes.get(geoSel);
  if (r && pan) {
    if (r.grid) map.fitBounds(L.latLngBounds(ellipse(r.proj, r.mx, r.my, r.cov, r.kReg * 1.2).concat(r.spots.map((s) => r.proj.inv(s.x, s.y)))), { maxZoom: 20, padding: [30, 30] });
    else map.fitBounds(L.latLng(r.proj.inv(r.x, r.y)).toBounds(r.dist * 2.2), { maxZoom: 20 });
  }
}

function renderFixList() {
  const fixes = geoData.fixes;
  $('#fixCount').textContent = fixes.length ? `${fixes.length} spot${fixes.length > 1 ? 's' : ''}` : '';
  if (!fixes.length) {
    $('#fixList').innerHTML = '<li class="empty0">No spots yet. Carry the Mac to a place you can find on the map, press <b>📍 I’m here</b>, then click that place. Stay still until recording ends, then move on to the next spot.</li>';
    return;
  }
  const html = fixes.map((f) => {
    const no = fixNo(f.id);
    const dur = fixEnd(f) - f.t0;
    const editing = editFix === f.id;
    const clash = fixes.filter((g) => g !== f && g.t0 < fixEnd(f) && f.t0 < fixEnd(g)).map((g) => fixNo(g.id));
    return `<li data-fix="${f.id}" class="${f.open ? 'rec' : ''}">
      <span class="num0">${no}</span>
      <span class="meta"><b>${esc(fixLabel(f))}</b> · ${fmtDur(Math.max(0, dur))}<br>${f.heard.wifi} Wi-Fi · ${f.heard.ble} Bluetooth heard${clash.length ? `<br><span class="warnTxt">⚠ overlaps spot ${clash.join(', ')} in time, so the same readings count at both places</span>` : ''}</span>
      <span class="acts">${editing ? '' : '<button class="btn ghost" data-act="edit" title="Edit times">Edit</button>'}</span>
      ${editing ? `<div class="edit">
        <label>From <input type="datetime-local" step="60" data-k="t0" value="${toLocalInput(f.t0)}"></label>
        <label>To <input type="datetime-local" step="60" data-k="t1" value="${f.t1 == null ? '' : toLocalInput(f.t1)}"></label>
        <div class="row end"><button class="btn ghost" data-act="del">Delete</button><button class="btn ghost" data-act="cancel">Cancel</button><button class="btn primary" data-act="save">Save</button></div>
      </div>` : ''}</li>`;
  }).join('');
  if (document.activeElement?.closest?.('#fixList')) return; // don't clobber an edit in progress
  $('#fixList').innerHTML = html;
}

function renderGeoList() {
  const q = $('#geoQ').value.trim().toLowerCase();
  const all = [...geoRes.values()];
  const rank = { fix: 0, amb: 1, range: 2 };
  const rows = all.filter((r) => !q || [displayName(r.d), r.d.id, r.d.meta.ssid, r.d.meta.bssid, r.d.vendor, r.d.dtype].join(' ').toLowerCase().includes(q))
    .sort((a, b) => rank[a.type] - rank[b.type] || (a.radius ?? a.dist) - (b.radius ?? b.dist));
  const nFix = all.filter((r) => r.type === 'fix').length, nAmb = all.filter((r) => r.type === 'amb').length;
  $('#geoCount').textContent = all.length ? `${nFix} located · ${nAmb} two-way · ${all.length - nFix - nAmb} range only` : '';
  const shown = rows.slice(0, 400);
  $('#geoList').innerHTML = shown.length ? shown.map((r) => {
    const d = r.d, qt = qualityText(r), ic = isTracker(d) ? 'trk' : d.kind;
    const sub = d.kind === 'wifi' ? [d.meta.bssid, d.meta.band].filter(Boolean).join(' · ') : typeLine(d);
    return `<div class="grow ${d.id === geoSel ? 'sel' : ''}" data-id="${esc(d.id)}"><span class="ic ${ic}">${d.kind === 'wifi' ? 'W' : 'B'}</span>
      <span class="t"><span class="n">${esc(displayName(d))}</span><span class="sub">${esc(sub)} · ${r.spots.length} spot${r.spots.length > 1 ? 's' : ''}</span></span>
      <span class="q ${qt.cls}">${esc(qt.t)}</span></div>`;
  }).join('') : `<div class="empty">${geoData.fixes.length ? 'Nothing heard at your spots yet (check the Wi-Fi / Bluetooth filters).' : 'Devices appear here once you’ve recorded at a spot.'}</div>`;
}

function renderRecBar() {
  const f = geoData.fixes.find((x) => x.open);
  const bar = $('#recBar');
  if (bar.hidden !== !f) {
    bar.hidden = !f;
    map?.invalidateSize({ pan: false }); // the bar changes the map's height
  }
  if (!f) return;
  const el = Math.max(0, geoNow() - f.t0);
  const total = f.t1 != null ? f.t1 - f.t0 : null;
  bar.innerHTML = `<span class="dotrec"></span>Recording at spot ${fixNo(f.id)}: <b>${fmtDur(el)}${total ? ` / ${fmtDur(total)}` : ''}</b>
    <span class="muted">${f.heard.wifi} Wi-Fi · ${f.heard.ble} Bluetooth so far. Keep the Mac still here.</span>
    <button class="btn" id="stopRec">Stop here</button>`;
}

function renderMapNote() {
  let t;
  if (armed === 'here') t = '<b>Click the spot where you (and the Mac) are standing right now.</b> Recording starts immediately. Esc cancels.';
  else if (armed === 'past') t = '<b>Click where you were.</b> Then enter when you were there. Esc cancels.';
  else t = `Positions are a best guess from signal strength with n = ${pathN().toFixed(1)} (${esc(S.env === 'custom' ? 'custom' : ENVS[S.env].label)}); pick the environment that matches the spots. ` +
    'Use 3 or more spots that surround the area, not all in a line: the garage and the end of the alley are in a line, so add one across the street or in the yard. ' +
    'Wi-Fi scans every 10 s, so 2 minutes gives about 12 readings per network. Bluetooth devices that change address (phones, AirTags) can’t be followed from spot to spot. ' +
    'Drag a numbered spot to correct it. Map tiles come from OpenStreetMap or Esri, so they see which area you view.';
  $('#mapNote').innerHTML = t;
}

// ---------- data ----------
let geoBusy = false;
async function geoPoll() {
  if (geoBusy || S.view !== 'map') return;
  geoBusy = true;
  try {
    const r = await fetch('/api/geo');
    geoData = await r.json();
    geoClock = geoData.now - Date.now() / 1000;
    const sig = JSON.stringify([geoData.fixes.map((f) => [f.id, f.lat, f.lon, f.t0, f.t1, f.heard]), geoData.devices.map((d) => [d.id, d.obs, d.p1m]), pathN(), S.geoWifi, S.geoBle, S.bleRef, S.bleTxOffset, S.wifi24, S.wifi5, S.wifi6]);
    if (sig !== geoSig) {
      const first = !geoSig;
      geoSig = sig;
      geoSolveAll();
      if (first && !S.mapCenter && geoData.fixes.length) map.fitBounds(L.latLngBounds(geoData.fixes.map((f) => [f.lat, f.lon])), { maxZoom: 19, padding: [40, 40] });
      geoRender();
    } else {
      renderRecBar();
    }
  } catch (_) { /* server restarting */ }
  geoBusy = false;
}
function geoRecompute() { geoSig = ''; geoPoll(); }

// ---------- controls ----------
$('#hereBtn').onclick = () => { clearCand(); setArmed('here'); };
$('#pastBtn').onclick = () => { clearCand(); setArmed('past'); };
$('#dwell').onchange = (e) => set('dwell', +e.target.value);
$$('#mapBase button').forEach((b) => (b.onclick = () => { S.mapBase = b.dataset.v; saveSettings(); geoApply(); }));
$('#geoWifi').onchange = (e) => { S.geoWifi = e.target.checked; saveSettings(); geoRecompute(); };
$('#geoBle').onchange = (e) => { S.geoBle = e.target.checked; saveSettings(); geoRecompute(); };
$('#geoQ').oninput = renderGeoList;
$('#geoCard').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const r = geoSel && geoRes.get(geoSel);
  if (!act || !r) return;
  if (act === 'close') { geoSel = null; geoRender(); }
  else if (act === 'detail') openDetail(r.d.id);
  else if (act === 'copy') {
    const [la, lo] = r.proj.inv(r.x, r.y);
    navigator.clipboard?.writeText(`${la.toFixed(6)}, ${lo.toFixed(6)}`);
  }
});
$('#geoList').addEventListener('click', (e) => {
  const row = e.target.closest('.grow');
  if (row) selectGeo(row.dataset.id, true);
});
// pointerdown: the bar re-renders every second and would swallow a click
$('#recBar').addEventListener('pointerdown', async (e) => {
  if (e.target.id !== 'stopRec') return;
  const f = geoData.fixes.find((x) => x.open);
  if (f) { await api(`/api/fix/${f.id}`, { stop: true }).catch(() => {}); geoSig = ''; geoPoll(); }
});
$('#fixList').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-fix]');
  if (!li) return;
  const id = +li.dataset.fix;
  const act = e.target.closest('[data-act]')?.dataset.act;
  const f = geoData.fixes.find((x) => x.id === id);
  if (!act) { if (f && map) map.setView([f.lat, f.lon], Math.max(map.getZoom(), 18)); return; }
  try {
    if (act === 'edit') { editFix = id; }
    else if (act === 'cancel') { editFix = null; }
    else if (act === 'del') {
      if (!confirm(`Delete spot ${fixNo(id)}? Its readings stay in the record; only the location tag is removed.`)) return;
      await api(`/api/fix/${id}`, { delete: true }); editFix = null; geoSig = '';
    } else if (act === 'save') {
      const t0 = fromLocalInput(li.querySelector('[data-k=t0]').value);
      const t1 = fromLocalInput(li.querySelector('[data-k=t1]').value);
      await api(`/api/fix/${id}`, { t0, t1 }); editFix = null; geoSig = '';
    }
  } catch (err) { alert(`Couldn’t save: ${err.message}`); return; }
  document.activeElement?.blur?.();
  renderFixList();
  geoPoll();
});
$('#pastCancel').onclick = () => { $('#pastForm').hidden = true; pastLatLng = null; L_.temp?.clearLayers(); };
$('#pastSave').onclick = async () => {
  const t0 = fromLocalInput($('#pastFrom').value), t1 = fromLocalInput($('#pastTo').value);
  if (!pastLatLng || !t0 || !t1) return;
  try {
    await api('/api/fixes', { lat: pastLatLng[0], lon: pastLatLng[1], t0, t1 });
  } catch (err) { alert(`Couldn’t save the visit: ${err.message}`); return; }
  $('#pastCancel').onclick();
  geoSig = ''; geoPoll();
};
$('#mapSearch').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#mapQ').value.trim();
  if (!q || !geoInit()) return;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`);
    const [hit] = await r.json();
    if (hit) map.setView([+hit.lat, +hit.lon], 19); else alert('No match for that address.');
  } catch (_) { alert('Address search needs an internet connection.'); }
});
$('#locateBtn').onclick = () => {
  if (!geoInit()) return;
  const btn = $('#locateBtn');
  const fallback = (why) => { const c = map.getCenter(); showCand(c, null, why); map.panTo(c, { animate: false }); };
  if (!navigator.geolocation) { fallback('not supported by this browser'); return; }
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (p) => {
      btn.disabled = false;
      const ll = L.latLng(p.coords.latitude, p.coords.longitude);
      const acc = p.coords.accuracy;
      showCand(ll, acc); // first: its bar changes the map's height
      // zoom so the accuracy circle fits, but close enough to place the pin precisely
      map.fitBounds(ll.toBounds(Math.max(40, Math.min(acc || 60, 800)) * 2.2), { maxZoom: 19 });
    },
    (err) => { btn.disabled = false; fallback(err.code === 1 ? 'permission denied' : err.message || 'timed out'); },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
};
$('#candOk').onclick = confirmCand;
$('#candCancel').onclick = clearCand;
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (cand) { clearCand(); e.stopPropagation(); }
  else if (armed) { setArmed(null); e.stopPropagation(); }
}, true);

setInterval(() => { if (S.view === 'map') geoPoll(); }, 3000);
setInterval(() => { if (S.view === 'map') renderRecBar(); }, 1000);
geoApply();
