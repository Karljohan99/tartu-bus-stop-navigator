/* Tartu Bus Stop Navigator – UI, GPS tracking and guidance. Routing lives in router.js. */
(function () {
  'use strict';
  const { Router, projectOnRoute, haversine, bearing, F_LANELET, F_GAP } = window.TartuRouter;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const SIM = params.has('sim') ? Math.max(1, parseFloat(params.get('sim')) || 1) : 0;   // ?sim=4 → simulated drive, 4× speed
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;

  const OFF_ROUTE_M = 35;        // further than this from the route counts as off-route
  const OFF_ROUTE_FIXES = 3;     // ... for this many consecutive fixes → reroute
  const ARRIVE_M = 30;
  const store = {
    get(k, d) { try { const v = localStorage.getItem('tsn.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tsn.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  let router, data, map, meMarker, destMarker;
  let state = 'idle';            // idle | locating | nav | arrived
  let pos = null;                // last fix {p:[lat,lon], heading, speed, acc, t}
  let dest = null, destIdx = -1, route = null, proj = null;
  let following = true, offCount = 0, lastRerouteT = 0, spoken = {}, userZoom = null;
  let visited = new Set(store.get('visited', []));
  let muted = store.get('muted', false);
  let cityOnly = store.get('cityOnly', false);    // pick only stops inside the Tartu city limits
  let wakeLock = null, toastTimer = 0;

  /* ------------------------------------------------------------------ map */
  async function loadStyle() {
    const blank = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': dark ? '#141a18' : '#eef0ea' } }] };
    if (params.has('nobase')) return { style: blank, base: false };
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch('https://tiles.openfreemap.org/styles/' + (dark ? 'dark' : 'liberty'), { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(r.status);
      const style = await r.json();
      style.layers = style.layers.filter(l => l.type !== 'fill-extrusion');   // 3D buildings hide the route
      return { style, base: true };
    } catch (e) { return { style: blank, base: false }; }
  }

  function lineFC(list) { return { type: 'FeatureCollection', features: list }; }
  function toLngLat(c) { return c.map(p => [p[1], p[0]]); }

  async function init() {
    const [d, st] = await Promise.all([fetch('data.json').then(r => r.json()), loadStyle()]);
    data = d; router = new Router(d);
    map = new maplibregl.Map({
      container: 'map', style: st.style, center: [26.7225, 58.378], zoom: 11.6, maxPitch: 60,
      attributionControl: false, dragRotate: true, pitchWithRotate: false, fadeDuration: 0,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '© OpenStreetMap contributors' }), 'bottom-left');
    map.on('load', () => {
      addLayers(st.base);
      const at = document.querySelector('.maplibregl-ctrl-attrib'); if (at) at.classList.remove('maplibregl-compact-show');   // start collapsed
    });
    // a manual pan stops camera follow until "re-centre" is tapped
    map.on('dragstart', () => { if (state === 'nav' || state === 'arrived') { following = false; $('recenter').hidden = false; } });
    map.on('zoomend', e => { if (e.originalEvent) userZoom = map.getZoom(); });
    const m = d.meta;
    $('ovStats').innerHTML = `${m.destinations_routable} stops · ${m.km_allowed} km of streets · <span id="visitedInfo"></span>`;
    updateVisitedInfo();
    renderMute();
    $('cityCount').textContent = `(${m.destinations_routable_in_city} of ${m.destinations_routable})`;
    renderCity();
    if (params.has('debug')) window.__nav = { get router() { return router; }, get route() { return route; }, get map() { return map; }, get state() { return state; }, get pos() { return pos; }, get dest() { return dest; }, onFix };
  }

  function addLayers(hasBase) {
    // context roads when there is no basemap (offline / tiles blocked)
    if (!hasBase) {
      fetch('roads.json').then(r => r.json()).then(roads => {
        const f = roads.map(([cls, flat]) => { const c = []; for (let i = 0; i < flat.length; i += 2) c.push([flat[i + 1], flat[i]]); return { type: 'Feature', properties: { c: cls }, geometry: { type: 'LineString', coordinates: c } }; });
        map.addSource('roads', { type: 'geojson', data: lineFC(f) });
        map.addLayer({ id: 'roads', type: 'line', source: 'roads', minzoom: 10, filter: ['any', ['<', ['get', 'c'], 2], ['>=', ['zoom'], 14]],
          paint: { 'line-color': dark ? '#3a4541' : '#ffffff', 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 11, ['match', ['get', 'c'], 0, 1.4, 0.5], 17, ['match', ['get', 'c'], 0, 14, 1, 9, 5]] },
          layout: { 'line-cap': 'round', 'line-join': 'round' } }, 'net');
      }).catch(() => {});
    }
    const feats = data.edges.map(e => {
      const c = []; for (let i = 0; i < e[6].length; i += 2) c.push([e[6][i + 1], e[6][i]]);
      return { type: 'Feature', properties: { s: e[4] & F_GAP ? 2 : e[4] & F_LANELET ? 0 : 1 }, geometry: { type: 'LineString', coordinates: c } };
    });
    map.addSource('net', { type: 'geojson', data: lineFC(feats) });
    map.addLayer({ id: 'net', type: 'line', source: 'net', filter: ['!=', ['get', 's'], 2],
      paint: { 'line-color': ['match', ['get', 's'], 0, '#8a63f5', '#e0762b'], 'line-opacity': 0.45, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 16, 5] },
      layout: { 'line-cap': 'round', 'line-join': 'round' } });
    map.addLayer({ id: 'net-gap', type: 'line', source: 'net', filter: ['==', ['get', 's'], 2],
      paint: { 'line-color': '#888', 'line-opacity': 0.8, 'line-dasharray': [1.5, 1.5], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 16, 4] } });
    map.addSource('stops', { type: 'geojson', data: lineFC(data.dests.map((s, i) => ({ type: 'Feature', properties: { i }, geometry: { type: 'Point', coordinates: [s.p[1], s.p[0]] } }))) });
    map.addLayer({ id: 'stops', type: 'circle', source: 'stops', minzoom: 11.5,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11.5, 1.5, 16, 5], 'circle-color': dark ? '#eef5f1' : '#10201a', 'circle-opacity': 0.55, 'circle-stroke-color': dark ? '#000' : '#fff', 'circle-stroke-width': 1 } });
    if (data.city && data.city.length) {
      map.addSource('city', { type: 'geojson', data: lineFC([{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: toLngLat(data.city) } }]) });
      map.addLayer({ id: 'city', type: 'line', source: 'city', layout: { visibility: cityOnly ? 'visible' : 'none' },
        paint: { 'line-color': dark ? '#19a577' : '#0b6e4f', 'line-width': 2.5, 'line-dasharray': [3, 2], 'line-opacity': 0.8 } });
    }
    map.addSource('route', { type: 'geojson', data: lineFC([]) });
    map.addLayer({ id: 'route-case', type: 'line', source: 'route', filter: ['==', ['get', 'k'], 'r'], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0b3d91', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 17, 18] } });
    map.addLayer({ id: 'route', type: 'line', source: 'route', filter: ['==', ['get', 'k'], 'r'], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#3b9dff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 17, 13] } });
    map.addLayer({ id: 'route-approach', type: 'line', source: 'route', filter: ['==', ['get', 'k'], 'a'],
      paint: { 'line-color': '#3b9dff', 'line-width': 4, 'line-dasharray': [1, 2] } });
  }

  function drawRoute() {
    const src = map.getSource('route'); if (!src) return;
    if (!route) { src.setData(lineFC([])); return; }
    // only the part still ahead
    let coords = route.coords;
    if (proj) coords = [proj.pt].concat(route.coords.slice(proj.idx + 1));
    const f = [{ type: 'Feature', properties: { k: 'r' }, geometry: { type: 'LineString', coordinates: toLngLat(coords) } }];
    if (pos && proj && proj.dist > OFF_ROUTE_M) f.push({ type: 'Feature', properties: { k: 'a' }, geometry: { type: 'LineString', coordinates: toLngLat([pos.p, proj.pt]) } });
    src.setData(lineFC(f));
  }

  /* ------------------------------------------------------------- markers */
  function ensureMarkers() {
    if (!meMarker) {
      const el = document.createElement('div'); el.className = 'me';
      el.innerHTML = '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="#fff"/><circle cx="24" cy="24" r="19" fill="#1a73e8"/><path d="M24 9 34 33 24 28 14 33z" fill="#fff"/></svg>';
      meMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' });
    }
    if (!destMarker) {
      const el = document.createElement('div'); el.className = 'destpin';
      el.innerHTML = '<svg viewBox="0 0 44 54"><path d="M22 1C10.4 1 1 10.2 1 21.6 1 37 22 53 22 53s21-16 21-31.4C43 10.200 33.600 1 22 1z" fill="#d93025" stroke="#fff" stroke-width="2"/><circle cx="22" cy="21" r="8" fill="#fff"/></svg>';
      destMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' });
    }
  }

  /* ---------------------------------------------------------------- text */
  function fmtDist(m) {
    if (m < 30) return 'now';
    if (m < 300) return Math.round(m / 10) * 10 + ' m';
    if (m < 1000) return Math.round(m / 50) * 50 + ' m';
    if (m < 10000) return (m / 1000).toFixed(1) + ' km';
    return Math.round(m / 1000) + ' km';
  }
  function fmtTime(s) { const m = Math.max(1, Math.round(s / 60)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; }
  function fmtClock(s) { const d = new Date(Date.now() + s * 1000); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); }
  const ORD = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
  function stepText(s) {
    switch (s.type) {
      case 'left': return 'Turn left'; case 'right': return 'Turn right';
      case 'slight-left': return 'Bear left'; case 'slight-right': return 'Bear right';
      case 'sharp-left': return 'Sharp left'; case 'sharp-right': return 'Sharp right';
      case 'keep-left': return 'Keep left'; case 'keep-right': return 'Keep right';
      case 'uturn': return 'Make a U-turn';
      case 'roundabout': return 'At the roundabout, take the ' + (ORD[s.exit] || s.exit + 'th') + ' exit';
      case 'arrive': return 'Arrive at the stop';
    }
    return 'Continue';
  }
  function arrowSvg(s) {
    const head = (a, cx, cy, len) => {      // stroke from (cx,cy) in direction a (deg, 0 = up) with an arrow head
      const r = a * Math.PI / 180, x = cx + len * Math.sin(r), y = cy - len * Math.cos(r);
      const hx = x + 13 * Math.sin(r), hy = y - 13 * Math.cos(r);
      const w = 15, px = Math.cos(r) * w, py = Math.sin(r) * w;
      return `<path d="M${cx} ${cy}L${x} ${y}" stroke="#fff" stroke-width="11" stroke-linecap="round" fill="none"/><path d="M${hx} ${hy}L${x + px - 6 * Math.sin(r)} ${y + py + 6 * Math.cos(r)}L${x - px - 6 * Math.sin(r)} ${y - py + 6 * Math.cos(r)}z" fill="#fff"/>`;
    };
    const wrap = inner => `<svg viewBox="0 0 100 100" aria-hidden="true">${inner}</svg>`;
    if (s.type === 'arrive') return wrap('<path d="M50 8C33 8 20 21 20 37c0 21 30 53 30 53s30-32 30-53C80 21 67 8 50 8z" fill="#fff"/><circle cx="50" cy="37" r="12" fill="var(--nav)"/>');
    if (s.type === 'uturn') return wrap('<path d="M68 92V44a20 20 0 0 0-40 0v14" stroke="#fff" stroke-width="11" stroke-linecap="round" fill="none"/><path d="M28 78 12 54h32z" fill="#fff"/>');
    if (s.type === 'roundabout') {
      const a = Math.max(-150, Math.min(150, s.angle));
      return wrap(`<path d="M50 96V70" stroke="#fff" stroke-width="11" stroke-linecap="round"/><circle cx="50" cy="52" r="17" stroke="#fff" stroke-width="9" fill="none"/>${head(a, 50 + 17 * Math.sin(a * Math.PI / 180), 52 - 17 * Math.cos(a * Math.PI / 180), 14)}<text x="50" y="59" text-anchor="middle" font-size="20" font-weight="800" fill="#fff" font-family="system-ui,sans-serif">${s.exit}</text>`);
    }
    const ang = { 'left': -90, 'right': 90, 'slight-left': -42, 'slight-right': 42, 'sharp-left': -135, 'sharp-right': 135, 'keep-left': -24, 'keep-right': 24 }[s.type] || 0;
    if (s.type.startsWith('keep')) {
      return wrap(`<path d="M50 94V60" stroke="#fff" stroke-width="11" stroke-linecap="round"/><path d="M50 60L${50 - Math.sign(ang) * 18} 22" stroke="#fff" stroke-opacity=".4" stroke-width="9" stroke-linecap="round"/>${head(ang, 50, 60, 32)}`);
    }
    return wrap(`<path d="M50 94V${ang ? 56 : 30}" stroke="#fff" stroke-width="11" stroke-linecap="round"/>${head(ang, 50, ang ? 56 : 30, ang ? 26 : 6)}`);
  }

  /* --------------------------------------------------------------- voice */
  function speak(text) {
    if (muted || !('speechSynthesis' in window)) return;
    try { const u = new SpeechSynthesisUtterance(text); u.lang = 'en-GB'; u.rate = 1.05; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) { /* ignore */ }
  }
  function renderMute() {
    const b = $('muteBtn'); b.classList.toggle('off', muted);
    b.innerHTML = muted
      ? '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/><path d="M16 9l6 6m0-6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/><path d="M15.500 8.500a5 5 0 0 1 0 7M18.500 5.500a9 9 0 0 1 0 13" stroke="currentColor" stroke-width="2.200" stroke-linecap="round" fill="none"/></svg>';
  }

  function renderCity() {
    $('cityChk').checked = cityOnly;
    const b = $('cityBtn'); b.classList.toggle('on', cityOnly); b.innerHTML = cityOnly ? 'CITY<br>ONLY' : 'ALL<br>STOPS';
    if (map && map.getLayer('city')) map.setLayoutProperty('city', 'visibility', cityOnly ? 'visible' : 'none');
  }
  function setCityOnly(v) {
    cityOnly = v; store.set('cityOnly', v); renderCity();
    if (state === 'idle') return;
    toast(v ? 'Only stops within Tartu city limits' : 'All stops', false, 2500);
    // the current trip is kept unless its stop is now excluded
    if (v && state === 'nav' && dest && !dest.c && pos) pickDestination();
  }

  function toast(msg, isErr, ms) {
    const t = $('toast'); clearTimeout(toastTimer);
    if (!msg) { t.hidden = true; return; }
    t.textContent = msg; t.classList.toggle('err', !!isErr); t.hidden = false;
    if (ms !== 0) toastTimer = setTimeout(() => { t.hidden = true; }, ms || 4000);
  }
  function updateVisitedInfo() {
    const el = $('visitedInfo'); if (!el) return;
    const n = [...visited].filter(i => i < data.dests.length).length;
    el.innerHTML = n ? `${n} visited (<a href="#" id="resetVisited">reset</a>)` : 'none visited yet';
    const a = $('resetVisited'); if (a) a.onclick = ev => { ev.preventDefault(); visited.clear(); store.set('visited', []); updateVisitedInfo(); };
  }

  /* ------------------------------------------------------------- routing */
  function computeRoute(d) {
    if (!pos) return null;
    const moving = pos.heading != null && pos.speed > 2;
    let starts = router.startCandidates(pos.p, moving ? pos.heading : null, 80);
    if (!starts.length && moving) starts = router.startCandidates(pos.p, null, 80);
    if (!starts.length) starts = router.startCandidates(pos.p, null, 5000).slice(0, 2);   // not on an allowed street: start from the nearest one
    if (!starts.length) return null;
    return router.route(starts, d);
  }

  function pickDestination() {
    if (!pos) return false;
    const all = data.dests.map((_, i) => i).filter(i => !cityOnly || data.dests[i].c);
    let pool = all.filter(i => !visited.has(i) && i !== destIdx);
    // every eligible stop done: start over with those (stops outside the current filter keep their visited mark)
    if (!pool.length) { all.forEach(i => visited.delete(i)); store.set('visited', [...visited]); pool = all.filter(i => i !== destIdx); }
    // a stop right next to the car is not much of a trip; skip those while others are available
    const far = pool.filter(i => haversine(pos.p, data.dests[i].p) > 400);
    if (far.length) pool = far;
    for (let tries = 0; tries < 30 && pool.length; tries++) {
      const j = Math.floor(Math.random() * pool.length), i = pool[j];
      const r = computeRoute(data.dests[i]);
      if (r) { setDestination(i, r); return true; }
      pool.splice(j, 1);
    }
    toast('No route found from here to any stop.', true, 6000);
    return false;
  }

  function setDestination(i, r) {
    destIdx = i; dest = data.dests[i]; route = r; proj = null; offCount = 0; spoken = {}; state = 'nav'; following = true;
    ensureMarkers();
    destMarker.setLngLat([dest.p[1], dest.p[0]]).addTo(map);
    $('overlay').hidden = true; $('banner').hidden = false; $('bottom').hidden = false; $('muteBtn').hidden = false; $('cityBtn').hidden = false; $('recenter').hidden = true;
    $('banner').classList.remove('arrived');
    $('destName').textContent = dest.n;
    $('nextBtn').textContent = 'New stop';
    speak('Route to ' + 'the next stop' + ', ' + fmtDistSpeech(r.dist) + '.');
    update(true);
    // show the whole trip briefly, then the follow camera takes over with the next fix
    const b = new maplibregl.LngLatBounds();
    r.coords.forEach(c => b.extend([c[1], c[0]])); b.extend([pos.p[1], pos.p[0]]);
    map.fitBounds(b, { padding: { top: 150, bottom: 140, left: 40, right: 40 }, duration: 600, pitch: 0, bearing: 0 });
    overviewUntil = Date.now() + 3500;
  }
  let overviewUntil = 0, lastReroutePos = null, gpsWaiting = false;

  function fmtDistSpeech(m) {
    if (m < 1000) return Math.round(m / 50) * 50 + ' metres';
    return (m / 1000).toFixed(1).replace('.0', '') + ' kilometres';
  }

  function reroute(reason) {
    const now = Date.now();
    if (now - lastRerouteT < 4000) return;
    // away from every allowed street the route only changes once the car has actually moved somewhere else
    const offNet = route && route.startDist > 80;
    if (offNet && lastReroutePos && haversine(pos.p, lastReroutePos) < 100) return;
    if (offNet) reason = null;
    lastRerouteT = now; lastReroutePos = pos.p;
    const r = computeRoute(dest);
    if (!r) return;
    route = r; proj = null; offCount = 0; spoken = {};
    if (reason) toast(reason, false, 2500);
    update(true);
  }

  /* ------------------------------------------------------- per-fix update */
  function onFix(p) {
    pos = p;
    ensureMarkers();
    if (state === 'locating') { toast(null); pickDestination(); }
    if (state === 'nav') {
      const pr = projectOnRoute(route, pos.p, proj ? proj.idx : null);
      const limit = Math.max(OFF_ROUTE_M, Math.min(60, (pos.acc || 0) * 1.5));
      // driving against the route direction also counts as off-route
      const wrongWay = pos.heading != null && pos.speed > 4 && Math.abs(((pos.heading - pr.brg + 540) % 360) - 180) > 120;
      if (pr.dist > limit || wrongWay) offCount++; else offCount = 0;
      proj = pr;
      if (offCount >= OFF_ROUTE_FIXES) reroute('Rerouting…');
    }
    update(false);
  }

  function update(force) {
    if (!pos) return;
    let course = pos.heading;
    let shown = pos.p;
    if (state === 'nav' && route) {
      if (!proj) proj = projectOnRoute(route, pos.p, null);
      const onRoute = proj.dist <= OFF_ROUTE_M;
      if (onRoute) { shown = proj.pt; if (course == null || pos.speed < 1.5) course = proj.brg; }
      const remaining = route.dist - proj.along;
      const frac = route.dist > 0 ? remaining / route.dist : 0;
      const remTime = route.time * frac;
      $('remDist').textContent = fmtDist(remaining).replace('now', '0 m');
      $('remTime').textContent = fmtTime(remTime);
      $('eta').textContent = fmtClock(remTime);
      // next manoeuvre
      const next = route.steps.find(s => s.at > proj.along - 8) || route.steps[route.steps.length - 1];
      const dStep = Math.max(0, next.at - proj.along);
      const banner = $('banner');
      banner.classList.toggle('offroute', !onRoute);
      if (!onRoute) {
        $('arrow').innerHTML = arrowSvg({ type: 'straight' });
        $('stepDist').textContent = fmtDist(proj.dist);
        $('stepName').textContent = 'Head to the highlighted route';
      } else {
        $('arrow').innerHTML = arrowSvg(next);
        $('stepDist').textContent = fmtDist(dStep);
        $('stepName').textContent = next.type === 'arrive' ? dest.n : (next.type === 'roundabout' ? ORD[next.exit] + ' exit' + (next.name ? ' · ' + next.name : '') : next.name || stepText(next));
        announce(next, dStep);
      }
      if (onRoute && remaining < ARRIVE_M) arrive();
      drawRoute();
    }
    meMarker.setLngLat([shown[1], shown[0]]).addTo(map);
    if (course != null) meMarker.setRotation(course);
    if (following && (state === 'nav' || state === 'arrived') && Date.now() > overviewUntil) {
      const v = pos.speed || 0;
      const zoom = userZoom != null ? userZoom : v > 16 ? 15.6 : v > 9 ? 16.3 : 17;
      map.easeTo({ center: [shown[1], shown[0]], bearing: course != null ? course : map.getBearing(), zoom, pitch: 50,
        padding: { top: Math.round(innerHeight * (innerWidth > innerHeight ? 0.3 : 0.42)), bottom: 0, left: 0, right: 0 }, duration: force ? 400 : 1000, easing: t => t, essential: true });
    }
  }

  function announce(step, d) {
    const key = route.steps.indexOf(step) + ':' + Math.round(step.at);
    const s = spoken[key] || (spoken[key] = {});
    const v = pos.speed || 0;
    const farAt = v > 14 ? 500 : 300, nearAt = Math.max(45, v * 5);
    if (!s.far && d <= farAt && d > nearAt + 80) { s.far = true; speak('In ' + fmtDistSpeech(d) + ', ' + lower(stepText(step)) + '.'); }
    else if (!s.near && d <= nearAt) { s.near = s.far = true; if (step.type !== 'arrive') speak(stepText(step) + '.'); }
  }
  function lower(t) { return t.charAt(0).toLowerCase() + t.slice(1); }

  function arrive() {
    state = 'arrived';
    visited.add(destIdx); store.set('visited', [...visited]); updateVisitedInfo();
    speak('You have arrived.');
    $('banner').classList.add('arrived'); $('banner').classList.remove('offroute');
    $('arrow').innerHTML = arrowSvg({ type: 'arrive' });
    $('stepDist').textContent = 'Arrived';
    $('stepName').textContent = dest.n;
    $('nextBtn').textContent = 'Next stop';
    $('remDist').textContent = '0 m'; $('remTime').textContent = `${[...visited].length} of ${data.dests.length} visited`; $('eta').textContent = '';
    route = null; proj = null; drawRoute();
  }

  /* ------------------------------------------------------- position input */
  function startGps() {
    if (SIM) return startSim();
    if (!('geolocation' in navigator)) { toast('This browser has no geolocation.', true, 0); return; }
    if (!window.isSecureContext) toast('Location needs HTTPS (or localhost).', true, 0);
    navigator.geolocation.watchPosition(g => {
      const c = g.coords;
      let heading = (c.heading != null && !isNaN(c.heading) && c.speed > 1) ? c.heading : null;
      // browsers often omit heading: derive it from movement
      if (heading == null && pos && haversine(pos.p, [c.latitude, c.longitude]) > 4) heading = bearing(pos.p, [c.latitude, c.longitude]);
      if (heading == null && pos) heading = pos.heading;
      let speed = c.speed;
      if ((speed == null || isNaN(speed)) && pos) speed = haversine(pos.p, [c.latitude, c.longitude]) / Math.max(0.5, (g.timestamp - pos.t) / 1000);
      if (gpsWaiting) { gpsWaiting = false; toast(null); }
      onFix({ p: [c.latitude, c.longitude], heading, speed: speed || 0, acc: c.accuracy, t: g.timestamp });
    }, err => {
      gpsWaiting = err.code !== 1;
      toast(err.code === 1 ? 'Location permission denied. Allow location for this site and reload.' : 'Waiting for GPS…', err.code === 1, err.code === 1 ? 0 : 5000);
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }

  /* Simulated drive (desktop testing): ?sim=<speed factor>[&from=lat,lon] */
  function startSim() {
    let p;
    if (params.has('from')) p = params.get('from').split(',').map(Number);
    else { const s = data.dests[Math.floor(Math.random() * data.dests.length)]; p = s.p; }
    let along = 0, simRoute = null, heading = null;
    onFix({ p, heading: null, speed: 0, acc: 5, t: Date.now() });
    setInterval(() => {
      if (state !== 'nav' || !route) { simRoute = null; return; }
      if (simRoute !== route) { simRoute = route; along = 0; }
      const k = route.edges.length ? router.speed[route.edges[Math.min(route.edges.length - 1, 0)] >> 1] : 10;
      const v = Math.min(14, k) * SIM;
      along = Math.min(route.dist, along + v);
      let i = 0; while (i < route.cum.length - 2 && route.cum[i + 1] < along) i++;
      const seg = route.cum[i + 1] - route.cum[i], t = seg > 0 ? (along - route.cum[i]) / seg : 0;
      const a = route.coords[i], b = route.coords[i + 1];
      if (seg > 0.5) heading = bearing(a, b);
      onFix({ p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading, speed: v / SIM, acc: 5, t: Date.now() });
    }, 1000);
  }

  async function keepAwake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* not critical */ }
  }

  /* -------------------------------------------------------------- events */
  $('startBtn').onclick = () => {
    $('overlay').hidden = true;
    state = 'locating';
    toast('Waiting for GPS…', false, 0);
    keepAwake();
    if ('speechSynthesis' in window && !muted) { try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch (e) { /* unlock audio */ } }
    startGps();
  };
  $('nextBtn').onclick = () => { if (pos) pickDestination(); };
  $('muteBtn').onclick = () => { muted = !muted; store.set('muted', muted); renderMute(); if (muted && 'speechSynthesis' in window) speechSynthesis.cancel(); };
  $('cityChk').onchange = e => setCityOnly(e.target.checked);
  $('cityBtn').onclick = () => setCityOnly(!cityOnly);
  $('recenter').onclick = () => { following = true; userZoom = null; overviewUntil = 0; $('recenter').hidden = true; update(true); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state !== 'idle') keepAwake(); });

  init().catch(e => { $('ovText').textContent = 'Could not load map data: ' + e.message; $('startBtn').disabled = true; });
})();
