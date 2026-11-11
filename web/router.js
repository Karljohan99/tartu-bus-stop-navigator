/* Offline router over the allowed Tartu street network (see build/build_graph.py).
 * Works in the browser (window.TartuRouter) and in node (module.exports) for tests.
 *
 * Directed edge id d = 2*k + dir, k = index into data.edges, dir 0 = along the stored
 * geometry, 1 = against it. Search runs over directed edges so that turn restrictions
 * and the no-U-turn rule are honoured.
 */
(function (root) {
  'use strict';
  const R = 6371008.8, RAD = Math.PI / 180;
  const F_FWD = 1, F_BWD = 2, F_LANELET = 4, F_BUS = 8, F_ROUNDABOUT = 16, F_LINK = 32, F_GAP = 64;

  function haversine(a, b) {
    const dLat = (b[0] - a[0]) * RAD, dLon = (b[1] - a[1]) * RAD;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bearing(a, b) {
    const y = Math.sin((b[1] - a[1]) * RAD) * Math.cos(b[0] * RAD);
    const x = Math.cos(a[0] * RAD) * Math.sin(b[0] * RAD) - Math.sin(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.cos((b[1] - a[1]) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }
  function angDiff(a, b) { return ((b - a + 540) % 360) - 180; }   // signed, + = clockwise (right)

  class MinHeap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
      while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v, topV = v[0], topK = k[0], lastK = k.pop(), lastV = v.pop(), n = k.length;
      if (n) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1; if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= lastK) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lastK; v[i] = lastV;
      }
      return [topK, topV];
    }
  }

  class Router {
    constructor(data) {
      this.data = data;
      this.nodes = data.nodes;
      this.names = data.names;
      const E = data.edges, n = E.length;
      this.n = n;
      this.geom = new Array(n);       // [[lat,lon],...]
      this.cum = new Array(n);        // cumulative metres along geometry
      this.len = new Float64Array(n);
      this.flags = new Uint8Array(n);
      this.speed = new Float32Array(n);   // m/s
      this.out = new Map();           // node -> [directed edge ids leaving it]
      for (let k = 0; k < n; k++) {
        const e = E[k], flat = e[6], g = [];
        for (let i = 0; i < flat.length; i += 2) g.push([flat[i], flat[i + 1]]);
        const cum = [0];
        for (let i = 1; i < g.length; i++) cum.push(cum[i - 1] + haversine(g[i - 1], g[i]));
        this.geom[k] = g; this.cum[k] = cum; this.len[k] = cum[cum.length - 1] || e[2];
        this.flags[k] = e[4]; this.speed[k] = Math.max(5, e[3]) / 3.6;
        if (e[4] & F_FWD) this._addOut(e[0], 2 * k);
        if (e[4] & F_BWD) this._addOut(e[1], 2 * k + 1);
      }
      this.banned = new Set(data.banned.map(p => p[0] * 4194304 + p[1]));
      this._buildGrid();
    }
    _addOut(node, d) { let a = this.out.get(node); if (!a) this.out.set(node, a = []); a.push(d); }
    from(d) { const e = this.data.edges[d >> 1]; return d & 1 ? e[1] : e[0]; }
    to(d) { const e = this.data.edges[d >> 1]; return d & 1 ? e[0] : e[1]; }
    name(d) { return this.names[this.data.edges[d >> 1][5]] || ''; }
    /* bearing when entering / leaving directed edge d */
    bearingIn(d) { const g = this.geom[d >> 1], m = g.length - 1; return d & 1 ? bearing(g[m], g[m - 1]) : bearing(g[0], g[1]); }
    bearingOut(d) { const g = this.geom[d >> 1], m = g.length - 1; return d & 1 ? bearing(g[1], g[0]) : bearing(g[m - 1], g[m]); }
    successors(d) {
      const outs = this.out.get(this.to(d)) || [], res = [];
      for (const o of outs) if ((o ^ 1) !== d && !this.banned.has(d * 4194304 + o)) res.push(o);
      if (!res.length && outs.length === 1 && (outs[0] ^ 1) === d) res.push(outs[0]);   // dead end
      return res;
    }

    /* ---- spatial index over geometry segments ---- */
    _buildGrid() {
      this.cell = 0.002;   // deg lat (~220 m); lon scaled
      this.lonScale = Math.cos(58.37 * RAD);
      this.grid = new Map();
      for (let k = 0; k < this.n; k++) {
        const g = this.geom[k];
        for (let i = 0; i < g.length - 1; i++) {
          const x0 = Math.floor(Math.min(g[i][1], g[i + 1][1]) * this.lonScale / this.cell), x1 = Math.floor(Math.max(g[i][1], g[i + 1][1]) * this.lonScale / this.cell);
          const y0 = Math.floor(Math.min(g[i][0], g[i + 1][0]) / this.cell), y1 = Math.floor(Math.max(g[i][0], g[i + 1][0]) / this.cell);
          for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
            const key = x * 100000 + y; let a = this.grid.get(key); if (!a) this.grid.set(key, a = []); a.push(k, i);
          }
        }
      }
    }
    /* Nearest points on the network. Returns candidates sorted by distance:
     * {k, off (m along geometry), dist (m), pt:[lat,lon], brg (bearing of geometry there)} — best one per edge. */
    nearest(p, maxDist) {
      maxDist = maxDist || 60;
      const ky = 111320, kx = 111320 * Math.cos(p[0] * RAD);
      const r = Math.ceil(maxDist / (this.cell * ky)) , cx = Math.floor(p[1] * this.lonScale / this.cell), cy = Math.floor(p[0] / this.cell);
      const best = new Map();
      for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) {
        const a = this.grid.get(x * 100000 + y); if (!a) continue;
        for (let j = 0; j < a.length; j += 2) {
          const k = a[j], i = a[j + 1], g = this.geom[k];
          const ax = (g[i][1] - p[1]) * kx, ay = (g[i][0] - p[0]) * ky, bx = (g[i + 1][1] - p[1]) * kx, by = (g[i + 1][0] - p[0]) * ky;
          const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
          let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
          const qx = ax + dx * t, qy = ay + dy * t, dist = Math.hypot(qx, qy);
          if (dist > maxDist) continue;
          const prev = best.get(k);
          if (!prev || dist < prev.dist) best.set(k, { k, dist, off: this.cum[k][i] + Math.sqrt(l2) * t, pt: [p[0] + qy / ky, p[1] + qx / kx], brg: (Math.atan2(dx, dy) / RAD + 360) % 360 });
        }
      }
      return [...best.values()].sort((a, b) => a.dist - b.dist);
    }
    /* Possible start states for a GPS fix. heading (deg) is used when given (vehicle is moving). */
    startCandidates(p, heading, maxDist) {
      const res = [];
      for (const c of this.nearest(p, maxDist || 80)) {
        for (let dir = 0; dir < 2; dir++) {
          if (!(this.flags[c.k] & (dir ? F_BWD : F_FWD))) continue;
          let pen = c.dist;
          if (heading != null) {
            const ad = Math.abs(angDiff(heading, dir ? (c.brg + 180) % 360 : c.brg));
            if (ad > 100) continue;           // driving the other way
            pen += ad * 0.4;
          }
          res.push({ d: 2 * c.k + dir, along: dir ? this.len[c.k] - c.off : c.off, dist: c.dist, pt: c.pt, pen });
        }
      }
      res.sort((a, b) => a.pen - b.pen);
      // keep the best few; penalise worse snaps so the closest sensible one wins unless it is a big detour
      return res.slice(0, 6).filter(c => c.pen <= res[0].pen + 25);
    }

    turnCost(d, o) {
      if ((o ^ 1) === d) return 40;                               // U-turn at a dead end
      const a = Math.abs(angDiff(this.bearingOut(d), this.bearingIn(o)));
      return a > 150 ? 25 : a > 50 ? 6 : 0;
    }

    /* Shortest-time route. starts: from startCandidates(); dest: {e: directed edge, o: metres along stored geometry}.
     * Returns null or {coords, cum, dist, time, steps, edges, startPt}. */
    route(starts, dest) {
      const target = dest.e, tk = target >> 1;
      const tAlong = target & 1 ? this.len[tk] - dest.o : dest.o;      // metres from the start of the directed edge
      const cost = new Map(), prev = new Map(), heap = new MinHeap();
      let bestEnd = null, bestCost = Infinity;
      for (const s of starts) {
        const k = s.d >> 1, c0 = s.pen * 0.5;      // prefer close snaps a little
        if (s.d === target && s.along <= tAlong + 1) {
          const c = c0 + (tAlong - s.along) / this.speed[k];
          if (c < bestCost) { bestCost = c; bestEnd = { direct: s }; }
        }
        const c = c0 + (this.len[k] - s.along) / this.speed[k];
        if (c < (cost.get(s.d) ?? Infinity)) { cost.set(s.d, c); prev.set(s.d, s); heap.push(c, s.d); }
      }
      while (heap.size) {
        const [c, d] = heap.pop();
        if (c > cost.get(d)) continue;
        if (c >= bestCost) break;
        for (const o of this.successors(d)) {
          const ok = o >> 1, tc = this.turnCost(d, o);
          if (o === target) {
            const ce = c + tc + tAlong / this.speed[ok];
            if (ce < bestCost) { bestCost = ce; bestEnd = { via: d }; }
          }
          const nc = c + tc + this.len[ok] / this.speed[ok];
          if (nc < (cost.get(o) ?? Infinity)) { cost.set(o, nc); prev.set(o, d); heap.push(nc, o); }
        }
      }
      if (!bestEnd) return null;
      // reconstruct list of directed edges
      let seq, start;
      if (bestEnd.direct) { seq = [target]; start = bestEnd.direct; }
      else {
        seq = [target]; let d = bestEnd.via;
        for (;;) { seq.push(d); const p = prev.get(d); if (typeof p === 'object') { start = p; break; } d = p; }
        seq.reverse();
      }
      return this._assemble(seq, start, tAlong);
    }

    _slice(d, a, b) {     // points of directed edge d between along-distances a..b
      const k = d >> 1, L = this.len[k];
      let g = this.geom[k], cum = this.cum[k];
      let lo = a, hi = b;
      if (d & 1) { lo = L - b; hi = L - a; }
      const pts = [];
      const interp = (m) => {
        let i = 0; while (i < cum.length - 2 && cum[i + 1] < m) i++;
        const seg = cum[i + 1] - cum[i], t = seg > 0 ? Math.max(0, Math.min(1, (m - cum[i]) / seg)) : 0;
        return [g[i][0] + (g[i + 1][0] - g[i][0]) * t, g[i][1] + (g[i + 1][1] - g[i][1]) * t];
      };
      pts.push(interp(lo));
      for (let i = 0; i < g.length; i++) if (cum[i] > lo + 0.01 && cum[i] < hi - 0.01) pts.push(g[i]);
      pts.push(interp(hi));
      if (d & 1) pts.reverse();
      return pts;
    }

    _assemble(seq, start, tAlong) {
      const coords = [], edgeAt = [];      // edgeAt[i] = index into seq of coords[i]
      const edgeStartIdx = [];
      let time = 0;
      for (let i = 0; i < seq.length; i++) {
        const d = seq[i], k = d >> 1;
        const a = i === 0 ? start.along : 0, b = i === seq.length - 1 ? tAlong : this.len[k];
        const pts = this._slice(d, Math.min(a, b), b);
        edgeStartIdx.push(coords.length ? coords.length - 1 : 0);
        for (let j = (coords.length ? 1 : 0); j < pts.length; j++) { coords.push(pts[j]); edgeAt.push(i); }
        time += Math.max(0, b - a) / this.speed[k] + (i ? this.turnCost(seq[i - 1], d) : 0);
      }
      if (coords.length === 1) coords.push(coords[0]);
      const cum = [0];
      for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
      const steps = this._steps(seq, edgeStartIdx, cum);
      steps.push({ type: 'arrive', at: cum[cum.length - 1], name: '', angle: 0 });
      return { coords, cum, dist: cum[cum.length - 1], time, steps, edges: seq, startPt: start.pt, startDist: start.dist };
    }

    /* Turn-by-turn steps: {type, at (m from route start), name, angle, exit?} */
    _steps(seq, edgeStartIdx, cum) {
      const steps = [];
      let i = 1;
      while (i < seq.length) {
        const d = seq[i - 1], o = seq[i], node = this.to(d), at = cum[edgeStartIdx[i]];
        const rbIn = this.flags[o >> 1] & F_ROUNDABOUT, rbPrev = this.flags[d >> 1] & F_ROUNDABOUT;
        if (rbIn && !rbPrev) {
          // count real exits until we leave the roundabout
          let exit = 0, j = i;
          while (j < seq.length && (this.flags[seq[j] >> 1] & F_ROUNDABOUT)) {
            if (this.nodes[this.to(seq[j])][2] & 2) exit++;
            j++;
          }
          if (j < seq.length) {
            steps.push({ type: 'roundabout', exit: Math.max(1, exit), at, name: this.name(seq[j]), angle: angDiff(this.bearingOut(d), this.bearingIn(seq[j])) });
            i = j + 1; continue;
          }
          i = j; continue;                     // destination is on the roundabout
        }
        if ((o ^ 1) === d) { steps.push({ type: 'uturn', at, name: this.name(o), angle: 180 }); i++; continue; }
        // slip road / ramp: describe the whole manoeuvre (before the link → after the link) as one turn
        if ((this.flags[o >> 1] & F_LINK) && !(this.flags[d >> 1] & F_LINK)) {
          let j = i, linkLen = 0;
          while (j < seq.length && (this.flags[seq[j] >> 1] & F_LINK)) { linkLen += this.len[seq[j] >> 1]; j++; }
          if (j < seq.length && linkLen < 250) {
            const a = angDiff(this.bearingOut(d), this.bearingIn(seq[j])), abs = Math.abs(a), side = a > 0 ? 'right' : 'left';
            const first = angDiff(this.bearingOut(d), this.bearingIn(o));
            const type = abs >= 150 ? 'uturn' : abs >= 110 ? 'sharp-' + side : abs >= 45 ? side : 'keep-' + (first >= 0 ? 'right' : 'left');
            steps.push({ type, at, name: this.name(seq[j]), angle: a, noMerge: true });
            i = j + 1; continue;
          }
        }
        const ang = angDiff(this.bearingOut(d), this.bearingIn(o)), abs = Math.abs(ang);
        const alts = this.out.get(node).filter(x => (x ^ 1) !== d && x !== o);
        const junction = (this.nodes[node][2] & 1) || alts.length > 0;
        const nameChange = this.name(d) !== this.name(o) && this.name(o) !== '';
        let type = null;
        if (junction && !rbPrev) {
          const side = ang > 0 ? 'right' : 'left';
          if (abs >= 150) type = 'uturn';
          else if (abs >= 110) type = 'sharp-' + side;
          else if (abs >= 45) type = side;
          else if (abs >= 20 && (nameChange || alts.some(x => Math.abs(angDiff(this.bearingOut(d), this.bearingIn(x))) < abs))) type = 'slight-' + side;
          else if (alts.length) {
            // fork: another branch leaves in almost the same direction
            const rival = alts.map(x => angDiff(this.bearingOut(d), this.bearingIn(x))).filter(a => Math.abs(a) < 40 && Math.abs(a - ang) > 8);
            if (rival.length && ((this.flags[o >> 1] & F_LINK) || (this.flags[d >> 1] & F_LINK) || nameChange)) type = rival.every(a => a > ang) ? 'keep-left' : rival.every(a => a < ang) ? 'keep-right' : null;
          }
        }
        if (type) steps.push({ type, at, name: this.name(o), angle: ang });
        i++;
      }
      // merge instructions that are practically at the same place (split intersections)
      const out = [];
      for (const s of steps) {
        const p = out[out.length - 1];
        if (p && s.at - p.at < 12 && p.type !== 'roundabout' && s.type !== 'roundabout' && !p.noMerge && !s.noMerge) {
          const a = p.angle + s.angle, abs = Math.abs(a), side = a > 0 ? 'right' : 'left';
          p.angle = a; p.name = s.name || p.name;
          p.type = abs >= 150 ? 'uturn' : abs >= 110 ? 'sharp-' + side : abs >= 45 ? side : abs >= 20 ? 'slight-' + side : null;
          if (!p.type) out.pop();
        } else out.push(s);
      }
      return out;
    }
  }

  /* Position of a point relative to a route polyline; searches near `hint` index first. */
  function projectOnRoute(route, p, hintIdx) {
    const c = route.coords, ky = 111320, kx = 111320 * Math.cos(p[0] * RAD);
    let best = null;
    const scan = (i0, i1) => {
      for (let i = Math.max(0, i0); i < Math.min(c.length - 1, i1); i++) {
        const ax = (c[i][1] - p[1]) * kx, ay = (c[i][0] - p[0]) * ky, bx = (c[i + 1][1] - p[1]) * kx, by = (c[i + 1][0] - p[0]) * ky;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
        const dist = Math.hypot(ax + dx * t, ay + dy * t);
        if (!best || dist < best.dist) best = { idx: i, t, dist, along: route.cum[i] + Math.sqrt(l2) * t, pt: [p[0] + (ay + dy * t) / ky, p[1] + (ax + dx * t) / kx], brg: (Math.atan2(dx, dy) / RAD + 360) % 360 };
      }
    };
    if (hintIdx != null) { scan(hintIdx - 3, hintIdx + 40); if (best && best.dist < 25) return best; }
    scan(0, c.length - 1);
    return best;
  }

  const api = { Router, projectOnRoute, haversine, bearing, angDiff, F_LANELET, F_BUS, F_GAP, F_ROUNDABOUT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TartuRouter = api;
})(typeof window !== 'undefined' ? window : globalThis);
