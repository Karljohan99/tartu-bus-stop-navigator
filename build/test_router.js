// Sanity test: route between random destination pairs, verify every one is reachable and the path is legal.
const { Router, projectOnRoute } = require('../web/router.js');
const data = require('../web/data.json');
const t0 = Date.now(); const r = new Router(data); console.log('init ms', Date.now() - t0, 'edges', r.n);
let fail = 0, n = 0, maxMs = 0, sumD = 0, illegal = 0;
const D = data.dests;
let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
for (let i = 0; i < D.length; i++) {
  const a = D[Math.floor(rnd() * D.length)], b = D[i];
  const starts = r.startCandidates(a.p, a.h, 80);
  const t = Date.now(); const res = r.route(starts, b); maxMs = Math.max(maxMs, Date.now() - t); n++;
  if (!res) { fail++; console.log('NO ROUTE', a.n, '->', b.n, starts.length); continue; }
  sumD += res.dist;
  for (let j = 1; j < res.edges.length; j++) {
    const d = res.edges[j - 1], o = res.edges[j];
    if (r.to(d) !== r.from(o) || !r.successors(d).includes(o)) illegal++;
    if (!(r.flags[o >> 1] & (o & 1 ? 2 : 1))) illegal++;
  }
  const endGap = require('../web/router.js').haversine(res.coords[res.coords.length - 1], b.p);
  if (endGap > 40) console.log('end far from dest', b.n, endGap.toFixed(0));
}
console.log({ n, fail, illegal, maxMs, avgKm: (sumD / n / 1000).toFixed(2) });
// show one route's steps
const a = D.find(d => d.n.startsWith('Soola')), b = D.find(d => d.n.startsWith('Maaülikool'));
const res = r.route(r.startCandidates(a.p, a.h), b);
console.log(a.n, '->', b.n, (res.dist / 1000).toFixed(2), 'km', (res.time / 60).toFixed(1), 'min');
for (const s of res.steps) console.log(' ', Math.round(s.at), 'm', s.type, s.exit || '', s.name, Math.round(s.angle));
