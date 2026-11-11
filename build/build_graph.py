#!/usr/bin/env python3
"""Build the routing graph for the Tartu navigation webapp.

Street network: OpenStreetMap. A street segment (per driving direction) is kept only if
  * it is covered by the lanelet2 map (lanelet centerlines run along it in that direction), or
  * it is a member way of a Tartu city bus route relation (network="Tartu linn").

Outputs web/data.json (graph + destinations) and build/report.json.

Usage: build_graph.py --lanelet tartu_large.osm --gpkg tartu_large.gpkg [--osm raw/osm.json]
"""
import argparse
import json
import math
import os
import sqlite3
import struct
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict

import numpy as np
import pyproj
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# ---- tunables -------------------------------------------------------------
SAMPLE_STEP = 4.0          # m, sampling of lanelet centerlines and OSM edges
MATCH_DIST = 9.0           # m, OSM sample -> lanelet centerline sample
MATCH_ANGLE = 35.0         # deg
COVER_FRAC = 0.7           # fraction of an edge's samples that must match
CONNECT_MAX = 600.0        # m, longest connector through streets that are neither lanelet nor bus
DEST_SNAP_DIST = 35.0      # m, destination -> allowed edge
DEST_ANGLE = 60.0          # deg, destination heading vs edge bearing
DEFAULT_SPEED = {          # km/h when no maxspeed tag
    'motorway': 90, 'trunk': 70, 'primary': 50, 'secondary': 50, 'tertiary': 50,
    'unclassified': 50, 'residential': 40, 'living_street': 20, 'service': 20,
    'busway': 30, 'road': 40,
}
NO_CAR_ACCESS = {'no', 'private', 'permit', 'delivery', 'customers', 'agricultural', 'forestry'}

to_m = pyproj.Transformer.from_crs(4326, 3301, always_xy=True)   # lon,lat -> L-EST97 x,y
to_ll = pyproj.Transformer.from_crs(3301, 4326, always_xy=True)


def bearing_xy(dx, dy):
    """Compass bearing (deg, 0=N, clockwise) of a vector in projected metres."""
    return math.degrees(math.atan2(dx, dy)) % 360.0


def angdiff(a, b):
    return abs((a - b + 180.0) % 360.0 - 180.0)


def resample(pts, step):
    """Resample polyline (N,2) at ~step spacing. Returns (points, bearings)."""
    pts = np.asarray(pts, dtype=float)
    seg = np.diff(pts, axis=0)
    seglen = np.hypot(seg[:, 0], seg[:, 1])
    keep = seglen > 1e-6
    if not keep.any():
        return np.empty((0, 2)), np.empty(0)
    cum = np.concatenate([[0], np.cumsum(seglen)])
    total = cum[-1]
    n = max(1, int(round(total / step)))
    d = (np.arange(n) + 0.5) * total / n
    idx = np.clip(np.searchsorted(cum, d, side='right') - 1, 0, len(seg) - 1)
    # skip zero-length segments
    for k in range(len(idx)):
        while seglen[idx[k]] <= 1e-6 and idx[k] < len(seg) - 1:
            idx[k] += 1
    t = np.where(seglen[idx] > 1e-6, (d - cum[idx]) / np.maximum(seglen[idx], 1e-6), 0)
    p = pts[idx] + seg[idx] * t[:, None]
    b = (np.degrees(np.arctan2(seg[idx, 0], seg[idx, 1]))) % 360.0
    return p, b


# ---- lanelet2 -------------------------------------------------------------
def load_lanelets(path):
    """Return centerline samples of all drivable lanelets: xy (N,2), bearing (N,), bidir (N,)."""
    nodes, ways = {}, {}
    lanelets = []
    for _, el in ET.iterparse(path, events=('end',)):
        if el.tag == 'node':
            nodes[el.get('id')] = (float(el.get('lon')), float(el.get('lat')))
            el.clear()
        elif el.tag == 'way':
            ways[el.get('id')] = [nd.get('ref') for nd in el.findall('nd')]
            el.clear()
        elif el.tag == 'relation':
            tags = {t.get('k'): t.get('v') for t in el.findall('tag')}
            if tags.get('type') == 'lanelet' and tags.get('subtype') in ('road', 'bus_lane', 'highway', 'play_street', 'emergency_lane'):
                left = right = None
                for m in el.findall('member'):
                    if m.get('role') == 'left':
                        left = m.get('ref')
                    elif m.get('role') == 'right':
                        right = m.get('ref')
                if left in ways and right in ways:
                    lanelets.append((left, right, tags.get('one_way', 'yes') == 'no'))
            el.clear()
    ids = list(nodes)
    lon = np.array([nodes[i][0] for i in ids])
    lat = np.array([nodes[i][1] for i in ids])
    x, y = to_m.transform(lon, lat)
    nxy = {i: (x[k], y[k]) for k, i in enumerate(ids)}

    def norm(pts, n):
        pts = np.asarray(pts)
        seg = np.hypot(*np.diff(pts, axis=0).T)
        cum = np.concatenate([[0], np.cumsum(seg)])
        if cum[-1] <= 0:
            return np.repeat(pts[:1], n, axis=0), 0.0
        d = np.linspace(0, cum[-1], n)
        return np.column_stack([np.interp(d, cum, pts[:, 0]), np.interp(d, cum, pts[:, 1])]), cum[-1]

    P, B, D = [], [], []
    for left, right, bidir in lanelets:
        lp = [nxy[n] for n in ways[left]]
        rp = [nxy[n] for n in ways[right]]
        if len(lp) < 2 or len(rp) < 2:
            continue
        # lanelet2 allows the right bound to be stored reversed; align it with the left
        lp, rp = np.asarray(lp), np.asarray(rp)
        if (np.hypot(*(lp[0] - rp[0])) + np.hypot(*(lp[-1] - rp[-1]))
                > np.hypot(*(lp[0] - rp[-1])) + np.hypot(*(lp[-1] - rp[0]))):
            rp = rp[::-1]
        n = max(2, int(max(len(lp), len(rp)) * 2))
        l, ll = norm(lp, n)
        r, rl = norm(rp, n)
        center = (l + r) / 2
        # driving direction: right bound is on the right-hand side of travel
        mid = len(center) // 2
        fwd = center[min(mid + 1, len(center) - 1)] - center[max(mid - 1, 0)]
        to_right = r[mid] - l[mid]
        if fwd[0] * to_right[1] - fwd[1] * to_right[0] > 0:   # right bound is on the left -> reverse
            center = center[::-1]
        p, b = resample(center, SAMPLE_STEP)
        P.append(p); B.append(b); D.append(np.full(len(p), bidir))
    return np.vstack(P), np.concatenate(B), np.concatenate(D), len(lanelets)


# ---- geopackage destinations ---------------------------------------------
def load_destinations(gpkg):
    con = sqlite3.connect('file:%s?mode=ro' % gpkg, uri=True)
    srs = con.execute("select srs_id from gpkg_geometry_columns where table_name='destinations'").fetchone()[0]
    tr = pyproj.Transformer.from_crs(srs, 3301, always_xy=True) if srs != 3301 else None
    out = []
    for fid, name, heading, blob in con.execute('select fid, name, heading, geom from destinations'):
        if blob is None:
            continue
        flags = blob[3]
        env = [0, 32, 48, 48, 64][(flags >> 1) & 7]
        wkb = blob[8 + env:]
        bo = '<' if wkb[0] == 1 else '>'
        x, y = struct.unpack(bo + 'dd', wkb[5:21])
        if tr:
            x, y = tr.transform(x, y)
        try:
            h = float(heading)
        except (TypeError, ValueError):
            h = None
        out.append({'fid': fid, 'name': (name or '').strip() or 'Destination %d' % fid, 'heading': h, 'x': x, 'y': y})
    return out


def load_city_limits(gpkg, name):
    """Polygon (EPSG:3301) of the named feature in the `sites` layer, or None."""
    from shapely import wkb
    con = sqlite3.connect('file:%s?mode=ro' % gpkg, uri=True)
    row = con.execute('select geom from sites where name = ?', (name,)).fetchone()
    if not row or row[0] is None:
        return None
    blob = row[0]
    env = [0, 32, 48, 48, 64][(blob[3] >> 1) & 7]
    return wkb.loads(bytes(blob[8 + env:]))


# ---- main -----------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lanelet', required=True, help='lanelet2 map (.osm) that defines the mapped streets')
    ap.add_argument('--gpkg', required=True, help='GeoPackage with a `destinations` point layer (name, heading) and a `sites` polygon layer')
    ap.add_argument('--osm', default=os.path.join(ROOT, 'raw', 'osm.json'))
    ap.add_argument('--city-site', default='tartu_city_limits', help='feature name in the gpkg `sites` layer used as the city limit')
    ap.add_argument('--out', default=os.path.join(ROOT, 'web', 'data.json'))
    args = ap.parse_args()

    print('loading lanelet2 map ...')
    LP, LB, LD, n_lanelets = load_lanelets(args.lanelet)
    print('  %d lanelets, %d centerline samples' % (n_lanelets, len(LP)))
    ltree = cKDTree(LP)

    print('loading OSM ...')
    osm = json.load(open(args.osm))
    onodes, oways, orels = {}, {}, []
    for e in osm['elements']:
        if e['type'] == 'node':
            onodes[e['id']] = (e['lon'], e['lat'])
        elif e['type'] == 'way':
            oways[e['id']] = e
        else:
            orels.append(e)
    osm_date = osm.get('osm3s', {}).get('timestamp_osm_base', '')

    bus_refs = defaultdict(set)   # way id -> set of line refs
    for r in orels:
        t = r.get('tags', {})
        if t.get('type') == 'route' and t.get('route') == 'bus' and t.get('network') == 'Tartu linn':
            for m in r['members']:
                if m['type'] == 'way':
                    bus_refs[m['ref']].add(t.get('ref', '?'))

    # candidate ways
    cand = {}
    for wid, w in oways.items():
        t = w.get('tags', {})
        hw = t.get('highway')
        if hw is None or hw in ('construction', 'proposed', 'pedestrian', 'footway', 'cycleway', 'path', 'track', 'platform'):
            continue
        if t.get('area') == 'yes' or len(w['nodes']) < 2:
            continue
        if any(n not in onodes for n in w['nodes']):
            continue
        cand[wid] = w

    # split ways into edges at junction nodes
    use = defaultdict(int)
    for w in cand.values():
        for i, n in enumerate(w['nodes']):
            use[n] += 1 if 0 < i < len(w['nodes']) - 1 else 2   # endpoints always split
    # nodes referenced by turn restrictions must be split points as well
    for r in orels:
        if r.get('tags', {}).get('type') == 'restriction':
            for m in r['members']:
                if m['type'] == 'node':
                    use[m['ref']] += 2

    lonlat = np.array([onodes[n] for n in onodes])
    nid_index = {n: i for i, n in enumerate(onodes)}
    X, Y = to_m.transform(lonlat[:, 0], lonlat[:, 1])

    def nxy(n):
        i = nid_index[n]
        return (X[i], Y[i])

    def coverage(pts):
        """Fraction of samples along pts (driving direction = pts order) matched by lanelets."""
        p, b = resample(pts, SAMPLE_STEP)
        if len(p) == 0:
            return 0.0
        ok = 0
        for q, qb, near in zip(p, b, ltree.query_ball_point(p, MATCH_DIST)):
            for j in near:
                d = angdiff(qb, LB[j])
                if d <= MATCH_ANGLE or (LD[j] and d >= 180 - MATCH_ANGLE):
                    ok += 1
                    break
        return ok / len(p)

    print('matching %d OSM ways against lanelets ...' % len(cand))
    edges = []   # dict per undirected OSM segment
    for wid, w in cand.items():
        t = w['tags']
        hw = t['highway']
        ow = t.get('oneway')
        roundabout = t.get('junction') in ('roundabout', 'circular')
        if ow in ('yes', 'true', '1') or roundabout or (hw in ('motorway', 'motorway_link') and ow != 'no'):
            dirs = (True, False)
        elif ow in ('-1', 'reverse'):
            dirs = (False, True)
        else:
            dirs = (True, True)
        acc = t.get('motor_vehicle', t.get('motorcar', t.get('vehicle', t.get('access'))))
        car_ok = acc not in NO_CAR_ACCESS and hw != 'busway'
        is_bus = wid in bus_refs
        try:
            speed = float(str(t.get('maxspeed', '')).split()[0])
        except (ValueError, IndexError):
            speed = DEFAULT_SPEED.get(hw.replace('_link', ''), 40)
        nodes = w['nodes']
        start = 0
        for i in range(1, len(nodes)):
            if use[nodes[i]] >= 2 or i == len(nodes) - 1:
                seg = nodes[start:i + 1]
                start = i
                if len(seg) < 2 or seg[0] == seg[-1] and len(seg) == 2:
                    continue
                pts = np.array([nxy(n) for n in seg])
                length = float(np.hypot(*np.diff(pts, axis=0).T).sum())
                if length < 0.05:
                    continue
                cf = coverage(pts) if dirs[0] else 0.0
                cb = coverage(pts[::-1]) if dirs[1] else 0.0
                lf, lb = cf >= COVER_FRAC, cb >= COVER_FRAC
                # bus streets are only usable by a car where cars are permitted
                bf = is_bus and car_ok and dirs[0]
                bb = is_bus and car_ok and dirs[1]
                edges.append({
                    'way': wid, 'nodes': seg, 'len': length, 'name': t.get('name', ''), 'ref': t.get('ref', ''),
                    'hw': hw, 'speed': speed, 'roundabout': roundabout, 'pts': pts,
                    'fwd': lf or bf, 'bwd': lb or bb,
                    'll': lf or lb, 'bus': is_bus and car_ok, 'cov': (cf, cb),
                    'lines': sorted(bus_refs.get(wid, ()), key=lambda s: (len(s), s)),
                    'bus_only_excluded': is_bus and not car_ok and not (lf or lb),
                    'dirs': dirs, 'car_ok': car_ok, 'gap': False,
                })

    # ---- gap bridging: a short uncovered piece between two lanelet-covered pieces ----
    # (e.g. OSM draws an intersection slightly differently). Allowed when partially covered.
    for e in edges:
        dirs_possible = e['cov']
        if not e['fwd'] and dirs_possible[0] >= 0.45 and e['len'] < 40:
            e['_cand_f'] = True
        if not e['bwd'] and dirs_possible[1] >= 0.45 and e['len'] < 40:
            e['_cand_b'] = True
    out_ok, in_ok = defaultdict(bool), defaultdict(bool)
    for e in edges:
        a, b = e['nodes'][0], e['nodes'][-1]
        if e['fwd']:
            out_ok[a] = True; in_ok[b] = True
        if e['bwd']:
            out_ok[b] = True; in_ok[a] = True
    bridged = 0
    for e in edges:
        a, b = e['nodes'][0], e['nodes'][-1]
        if e.pop('_cand_f', False) and in_ok[a] and out_ok[b]:
            e['fwd'] = e['ll'] = True; bridged += 1
        if e.pop('_cand_b', False) and in_ok[b] and out_ok[a]:
            e['bwd'] = e['ll'] = True; bridged += 1

    def build(edges):
        allowed = [e for e in edges if e['fwd'] or e['bwd']]
        print('  %d segments total, %d allowed (%d bridged)' % (len(edges), len(allowed), bridged))

        # ---- directed edge graph, turn restrictions --------------------------------
        # directed edge id = 2*i (forward) / 2*i+1 (backward) over `allowed`
        def d_from(d):
            e = allowed[d >> 1]
            return e['nodes'][-1] if d & 1 else e['nodes'][0]

        def d_to(d):
            e = allowed[d >> 1]
            return e['nodes'][0] if d & 1 else e['nodes'][-1]

        dedges = []
        for i, e in enumerate(allowed):
            if e['fwd']:
                dedges.append(2 * i)
            if e['bwd']:
                dedges.append(2 * i + 1)
        out_at = defaultdict(list)
        for d in dedges:
            out_at[d_from(d)].append(d)
        in_at = defaultdict(list)
        for d in dedges:
            in_at[d_to(d)].append(d)

        banned = set()          # (d_in, d_out)
        n_restr = 0
        for r in orels:
            t = r.get('tags', {})
            if t.get('type') != 'restriction':
                continue
            kind = t.get('restriction') or t.get('restriction:motorcar') or ''
            if t.get('except') and 'motorcar' in t['except']:
                continue
            frm = [m['ref'] for m in r['members'] if m['role'] == 'from' and m['type'] == 'way']
            to = [m['ref'] for m in r['members'] if m['role'] == 'to' and m['type'] == 'way']
            via = [m['ref'] for m in r['members'] if m['role'] == 'via' and m['type'] == 'node']
            if len(via) != 1 or not frm or not to:
                continue    # via-way restrictions are rare here; ignored
            v = via[0]
            ins = [d for d in in_at.get(v, []) if allowed[d >> 1]['way'] in frm]
            outs_to = [d for d in out_at.get(v, []) if allowed[d >> 1]['way'] in to]
            if not ins:
                continue
            if kind.startswith('no_'):
                for a in ins:
                    for b in outs_to:
                        banned.add((a, b)); n_restr += 1
            elif kind.startswith('only_'):
                if not outs_to:
                    continue   # mandated exit is not part of our network; don't trap the driver
                for a in ins:
                    for b in out_at.get(v, []):
                        if b not in outs_to:
                            banned.add((a, b)); n_restr += 1

        def successors(d):
            v = d_to(d)
            outs = out_at.get(v, [])
            res = [o for o in outs if (o ^ 1) != d and (d, o) not in banned]
            if not res and len(outs) == 1 and (outs[0] ^ 1) == d:
                res = [outs[0]]            # dead end: U-turn allowed
            return res

        # ---- largest strongly connected component over directed edges (Tarjan, iterative) ----
        index = {}
        low = {}
        onstack = set()
        stack = []
        comps = []
        counter = [0]
        for root in dedges:
            if root in index:
                continue
            work = [(root, iter(successors(root)))]
            index[root] = low[root] = counter[0]; counter[0] += 1
            stack.append(root); onstack.add(root)
            while work:
                v, it = work[-1]
                advanced = False
                for w in it:
                    if w not in index:
                        index[w] = low[w] = counter[0]; counter[0] += 1
                        stack.append(w); onstack.add(w)
                        work.append((w, iter(successors(w))))
                        advanced = True
                        break
                    elif w in onstack:
                        low[v] = min(low[v], index[w])
                if advanced:
                    continue
                work.pop()
                if work:
                    low[work[-1][0]] = min(low[work[-1][0]], low[v])
                if low[v] == index[v]:
                    comp = []
                    while True:
                        w = stack.pop(); onstack.discard(w); comp.append(w)
                        if w == v:
                            break
                    comps.append(comp)
        comps.sort(key=len, reverse=True)
        main_comp = set(comps[0])
        dropped_len = sum(allowed[d >> 1]['len'] for d in dedges if d not in main_comp)
        kept_len = sum(allowed[d >> 1]['len'] for d in main_comp)
        print('  directed edges: %d, main component: %d (%.1f km kept, %.1f km dropped as not mutually reachable)'
              % (len(dedges), len(main_comp), kept_len / 1000, dropped_len / 1000))
        return allowed, dedges, banned, main_comp, dropped_len, d_from, d_to

    allowed, dedges, banned, main_comp, dropped_len, d_from, d_to = build(edges)

    # ---- short connectors ------------------------------------------------------
    # OSM bus relations often omit roundabout pieces or the opposite carriageway, which
    # leaves bus streets cut off from the rest. Bridge such islands with the shortest
    # ordinary public road, if the detour needed is short compared to what it connects.
    import heapq
    eid = {id(e): i for i, e in enumerate(edges)}
    adj_f, adj_r = defaultdict(list), defaultdict(list)     # node -> (other, cost, edge index)
    for i, e in enumerate(edges):
        a, b = e['nodes'][0], e['nodes'][-1]
        usable = e['car_ok'] and e['hw'] != 'service'
        for frm, to, ok_allowed, ok_dir in ((a, b, e['fwd'], e['dirs'][0]), (b, a, e['bwd'], e['dirs'][1])):
            if ok_allowed:
                c = 0.0
            elif usable and ok_dir:
                c = e['len']
            else:
                continue
            adj_f[frm].append((to, c, i)); adj_r[to].append((frm, c, i))
    main_nodes = set()
    for d in main_comp:
        main_nodes.add(d_from(d)); main_nodes.add(d_to(d))

    def dijkstra(adj):
        dist = {n: 0.0 for n in main_nodes}
        par = {}
        pq = [(0.0, n) for n in main_nodes]
        heapq.heapify(pq)
        while pq:
            dcur, u = heapq.heappop(pq)
            if dcur > dist.get(u, 1e18) or dcur > CONNECT_MAX:
                continue
            for v, c, i in adj[u]:
                nd = dcur + c
                if nd < dist.get(v, 1e18):
                    dist[v] = nd; par[v] = (u, i); heapq.heappush(pq, (nd, v))
        return dist, par
    dist_out, par_out = dijkstra(adj_f)     # main -> node
    dist_in, par_in = dijkstra(adj_r)       # node -> main
    # weakly connected groups of dropped edges
    uf = {}
    def find(x):
        while uf.setdefault(x, x) != x:
            uf[x] = uf[uf[x]]; x = uf[x]
        return x
    dropped = [d for d in dedges if d not in main_comp]
    for d in dropped:
        uf[find(d_from(d))] = find(d_to(d))
    groups = defaultdict(lambda: [0.0, set()])
    for d in dropped:
        g = groups[find(d_from(d))]
        g[0] += allowed[d >> 1]['len']; g[1].update((d_from(d), d_to(d)))
    n_gap = 0
    group_len = {k: v[0] for k, v in groups.items()}
    for d in dropped:
        L = group_len[find(d_from(d))]
        cin = (dist_out.get(d_from(d), 1e18), d_from(d))
        cout = (dist_in.get(d_to(d), 1e18), d_to(d))
        if cin[0] > CONNECT_MAX or cout[0] > CONNECT_MAX or cin[0] + cout[0] > L:
            continue
        for (c, n), par in ((cin, par_out), (cout, par_in)):
            while n in par:
                u, i = par[n]
                e = edges[i]
                a, b = e['nodes'][0], e['nodes'][-1]
                # direction travelled: par_out stores u->n, par_in stores n->u
                frm, to = (u, n) if par is par_out else (n, u)
                if frm == a and to == b and not e['fwd']:
                    e['fwd'] = e['gap'] = True; n_gap += 1
                elif frm == b and to == a and not e['bwd']:
                    e['bwd'] = e['gap'] = True; n_gap += 1
                n = u
    print('  added %d connector segment directions' % n_gap)
    allowed, dedges, banned, main_comp, dropped_len, d_from, d_to = build(edges)

    # ---- compact output graph ------------------------------------------------
    final = []          # undirected segments having >=1 direction in main component
    remap = {}          # old directed id -> new directed id
    for i, e in enumerate(allowed):
        f, b = (2 * i) in main_comp, (2 * i + 1) in main_comp
        if not (f or b):
            continue
        k = len(final)
        e2 = dict(e); e2['fwd'], e2['bwd'] = f, b
        final.append(e2)
        remap[2 * i] = 2 * k
        remap[2 * i + 1] = 2 * k + 1

    node_ids = {}
    out_nodes = []

    def node_idx(n):
        if n not in node_ids:
            node_ids[n] = len(out_nodes)
            out_nodes.append(n)
        return node_ids[n]

    names = {}

    def name_idx(s):
        if s not in names:
            names[s] = len(names)
        return names[s]

    jedges = []
    for e in final:
        lon, lat = to_ll.transform(e['pts'][:, 0], e['pts'][:, 1])
        flat = []
        for a, b in zip(lat, lon):
            flat += [round(float(a), 6), round(float(b), 6)]
        flags = (1 if e['fwd'] else 0) | (2 if e['bwd'] else 0) | (4 if e['ll'] else 0) | (8 if e['bus'] else 0) | (16 if e['roundabout'] else 0) | (32 if e['hw'].endswith('_link') else 0) | (64 if e['gap'] else 0)
        jedges.append([node_idx(e['nodes'][0]), node_idx(e['nodes'][-1]), round(e['len'], 1), int(e['speed']),
                       flags, name_idx(e['name'] or e['ref']), flat])
    jban = sorted([remap[a], remap[b]] for a, b in banned if a in remap and b in remap)

    # ---- destinations --------------------------------------------------------
    print('snapping destinations ...')
    dests = load_destinations(args.gpkg)
    # sample points of final edges for snapping
    SP, SE, SO, SB = [], [], [], []
    for k, e in enumerate(final):
        pts = e['pts']
        seg = np.diff(pts, axis=0)
        sl = np.hypot(seg[:, 0], seg[:, 1])
        cum = np.concatenate([[0], np.cumsum(sl)])
        n = max(1, int(math.ceil(cum[-1] / 2.0)))
        d = np.linspace(0, cum[-1], n + 1)
        idx = np.clip(np.searchsorted(cum, d, side='right') - 1, 0, len(seg) - 1)
        tt = np.where(sl[idx] > 0, (d - cum[idx]) / np.maximum(sl[idx], 1e-9), 0)
        p = pts[idx] + seg[idx] * tt[:, None]
        b = np.degrees(np.arctan2(seg[idx, 0], seg[idx, 1])) % 360
        SP.append(p); SE.append(np.full(len(p), k)); SO.append(d); SB.append(b)
    SP = np.vstack(SP); SE = np.concatenate(SE); SO = np.concatenate(SO); SB = np.concatenate(SB)
    stree = cKDTree(SP)

    # heading convention check: compass (0=N, cw) vs math (0=E, ccw) -- pick whichever agrees with the roads
    def score(conv):
        s = 0
        for dd in dests:
            if dd['heading'] is None:
                continue
            h = dd['heading'] if conv == 'compass' else (90 - dd['heading']) % 360
            dist, j = stree.query([dd['x'], dd['y']])
            if dist < 20:
                d = angdiff(h, SB[j])
                if d < 30 or d > 150:
                    s += 1
        return s
    sc, sm = score('compass'), score('math')
    conv = 'compass' if sc >= sm else 'math'
    print('  heading convention: %s (compass agrees for %d, math for %d)' % (conv, sc, sm))

    city = load_city_limits(args.gpkg, args.city_site)
    if city is None:
        print('  WARNING: no site named %r - all stops are treated as inside the city' % args.city_site)
    from shapely.geometry import Point
    jdest, unreach = [], []
    n_h_lanelet = 0
    for dd in dests:
        h = dd['heading']
        if h is not None and conv == 'math':
            h = (90 - h) % 360
        side_only = False
        if h is None:
            # destinations sit on a lane: take the driving direction of the lanelet underneath
            dist, j = ltree.query([dd['x'], dd['y']])
            if dist <= 6.0 and not LD[j]:
                h = float(LB[j]); n_h_lanelet += 1
            else:
                side_only = True   # fall back to "stop is on the right-hand side of travel"
        best = None
        for j in stree.query_ball_point([dd['x'], dd['y']], DEST_SNAP_DIST):
            e = final[SE[j]]
            dist = math.hypot(SP[j][0] - dd['x'], SP[j][1] - dd['y'])
            for direction, okdir, brg in ((0, e['fwd'], SB[j]), (1, e['bwd'], (SB[j] + 180) % 360)):
                if not okdir:
                    continue
                if h is not None:
                    ad = angdiff(h, brg)
                    if ad > DEST_ANGLE:
                        continue
                else:
                    r = math.radians(brg)
                    cross = math.sin(r) * (dd['y'] - SP[j][1]) - math.cos(r) * (dd['x'] - SP[j][0])
                    ad = 0 if cross <= 0 else 100   # prefer the direction that has the point on its right
                cost = dist + ad * 0.15
                if best is None or cost < best[0]:
                    best = (cost, int(SE[j]) * 2 + direction, float(SO[j]), dist)
        lon, lat = to_ll.transform(dd['x'], dd['y'])
        if best is None:
            unreach.append({'name': dd['name'], 'on_lanelet': bool(ltree.query([dd['x'], dd['y']])[0] <= 6.0), 'lat': round(lat, 6), 'lon': round(lon, 6)})
            continue
        jdest.append({'n': dd['name'], 'p': [round(lat, 6), round(lon, 6)], 'h': None if h is None else round(h), 'd': round(best[3], 1),
                      'e': best[1], 'o': round(best[2], 1),
                      'c': 1 if city is None or city.contains(Point(dd['x'], dd['y'])) else 0})
    print('  %d destinations, %d routable, %d not on the allowed network' % (len(dests), len(jdest), len(unreach)))

    # node flags for turn instructions: 1 = real junction (>=3 public road arms),
    # 2 = a real exit leaves a roundabout here (also exits that are not part of our network)
    arms = defaultdict(int)
    rb_exit = set()
    for w in cand.values():
        t = w['tags']
        if not (t.get('highway') != 'service' or w['id'] in bus_refs):
            continue
        ns = w['nodes']
        rb = t.get('junction') in ('roundabout', 'circular')
        ow = t.get('oneway') in ('yes', 'true', '1')
        for i, n in enumerate(ns):
            arms[n] += (1 if i > 0 else 0) + (1 if i < len(ns) - 1 else 0)
            if not rb and (i < len(ns) - 1 if ow else True) and not (t.get('oneway') == '-1' and i == 0):
                rb_exit.add(n)
    node_ll = []
    for n in out_nodes:
        lon, lat = onodes[n]
        node_ll.append([round(lat, 6), round(lon, 6), (1 if arms[n] >= 3 else 0) | (2 if n in rb_exit else 0)])

    # background roads (context only, never routed on) for when no basemap tiles are available
    bg = []
    for w in cand.values():
        t = w['tags']
        if t['highway'] == 'service' and t.get('service') in ('driveway', 'parking_aisle', 'drive-through', 'alley', 'slipway'):
            continue
        if t.get('access') in ('private', 'no') and w['id'] not in bus_refs:
            continue
        cls = 0 if t['highway'].split('_')[0] in ('motorway', 'trunk', 'primary', 'secondary', 'tertiary') else (2 if t['highway'] == 'service' else 1)
        flat = []
        for n in w['nodes']:
            lon, lat = onodes[n]
            flat += [round(lat, 5), round(lon, 5)]
        bg.append([cls, flat])
    with open(os.path.join(os.path.dirname(args.out), 'roads.json'), 'w') as f:
        json.dump(bg, f, separators=(',', ':'))

    km = lambda es: round(sum(e['len'] for e in es) / 1000, 1)
    report = {
        'osm_timestamp': osm_date,
        'lanelets': n_lanelets,
        'segments_total': len(edges),
        'segments_allowed': len(final),
        'km_allowed': km(final),
        'km_lanelet': km([e for e in final if e['ll']]),
        'km_bus_only_source': km([e for e in final if e['bus'] and not e['ll']]),
        'km_both': km([e for e in final if e['bus'] and e['ll']]),
        'km_connectors': km([e for e in final if e['gap']]),
        'connector_streets': sorted({e['name'] or e['hw'] for e in final if e['gap']}),
        'km_dropped_disconnected': round(dropped_len / 1000, 1),
        'bus_only_ways_excluded_no_car_access': sorted({e['way'] for e in edges if e['bus_only_excluded']}),
        'turn_restriction_pairs': len(jban),
        'destinations_total': len(dests),
        'destinations_routable': len(jdest),
        'destinations_routable_in_city': sum(d['c'] for d in jdest),
        'destinations_unroutable': unreach,
        'heading_convention': conv,
        'destination_headings_from_lanelet': n_h_lanelet,
    }
    data = {
        'meta': {k: report[k] for k in ('osm_timestamp', 'km_allowed', 'km_lanelet', 'km_bus_only_source', 'km_connectors', 'destinations_routable', 'destinations_routable_in_city')},
        'names': [s for s, _ in sorted(names.items(), key=lambda kv: kv[1])],
        'nodes': node_ll,
        'edges': jedges,
        'banned': jban,
        'dests': jdest,
        'city': [] if city is None else [[round(float(la), 5), round(float(lo), 5)] for lo, la in
                                         (to_ll.transform(x, y) for x, y in city.exterior.coords)],
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
    with open(os.path.join(HERE, 'report.json'), 'w') as f:
        json.dump(report, f, indent=1, ensure_ascii=False)
    # debug layer for inspecting the matching in QGIS
    feats = []
    for e in edges:
        lon, lat = to_ll.transform(e['pts'][:, 0], e['pts'][:, 1])
        feats.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': [[round(float(a), 6), round(float(b), 6)] for a, b in zip(lon, lat)]},
                      'properties': {'way': e['way'], 'name': e['name'], 'hw': e['hw'], 'fwd': bool(e['fwd']), 'bwd': bool(e['bwd']),
                                     'lanelet': bool(e['ll']), 'bus': bool(e['bus']), 'gap': bool(e['gap']), 'cov_f': round(e['cov'][0], 2), 'cov_b': round(e['cov'][1], 2)}})
    with open(os.path.join(HERE, 'debug_segments.geojson'), 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': feats}, f)
    print('wrote %s (%.0f kB)' % (args.out, os.path.getsize(args.out) / 1024))
    print(json.dumps({k: v for k, v in report.items() if k != 'destinations_unroutable'}, indent=1))


if __name__ == '__main__':
    sys.exit(main())
