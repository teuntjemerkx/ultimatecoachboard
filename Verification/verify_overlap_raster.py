"""Independent reference: rasterize every foot on a fixed 1 mm world grid and apply the rule text literally:
'some point of A is closer to the line than every point of B'."""
import math, random, numpy as np, overlap as o
G = 0.001
def raster(verts4):
    loop = np.array([verts4[0], verts4[1], verts4[3], verts4[2]])
    lo, hi = loop.min(0), loop.max(0)
    xs = (np.arange(math.floor(lo[0] / G), math.ceil(hi[0] / G) + 1) + 0.5) * G
    ys = (np.arange(math.floor(lo[1] / G), math.ceil(hi[1] / G) + 1) + 0.5) * G
    X, Y = np.meshgrid(xs, ys); P = np.stack([X.ravel(), Y.ravel()], 1)
    inside = np.ones(len(P), bool)
    for i in range(4):  # convex polygon test, consistent orientation
        a, b = loop[i], loop[(i + 1) % 4]
        cross = (b[0]-a[0])*(P[:,1]-a[1]) - (b[1]-a[1])*(P[:,0]-a[0])
        inside &= cross >= 0
    if not inside.any():
        inside = np.ones(len(P), bool)
        for i in range(4):
            a, b = loop[i], loop[(i + 1) % 4]
            cross = (b[0]-a[0])*(P[:,1]-a[1]) - (b[1]-a[1])*(P[:,0]-a[0])
            inside &= cross <= 0
    return P[inside]
def ref(team, st, serving):
    pts = {p: np.vstack([raster(v[:4]), raster(v[4:])]) for p, v in
           ((p, o.foot_vertices(*xy, st[p])) for p, xy in team.items())}
    out = []
    for a, b, k in o.PAIRS:
        if serving and "P1" in (a, b): continue
        if k == "fb": fa, fb = pts[a][:, 1], pts[b][:, 1]
        elif k == "left": fa, fb = pts[a][:, 0], pts[b][:, 0]
        else: fa, fb = 9 - pts[a][:, 0], 9 - pts[b][:, 0]
        out.append(fb.min() - fa.min())   # >0  <=>  exists point of A closer than all points of B
    return out
random.seed(11); N = 3000; tot = agree = amb = 0; md = 0
for n in range(N):
    cl, cd = random.uniform(1.5, 7.5), random.uniform(1.0, 7.5)
    team = {p: (cl + random.uniform(-0.6, 0.6), cd + random.uniform(-0.6, 0.6)) for p in ("P1","P2","P3","P4","P5","P6")}
    st = {p: o.Stance(math.radians(random.uniform(-60, 60)), random.uniform(0.2, 0.45), random.uniform(-0.25, 0.25)) for p in team}
    serving = random.random() < 0.5
    a = [m for *_, m in o.evaluate(team, serving, st)]; b = ref(team, st, serving)
    for x, y in zip(a, b):
        tot += 1; md = max(md, abs(x - y))
        if abs(x) < 0.0015: amb += 1; continue
        agree += (x > 0) == (y > 0)
print(f"formations={N} constraints={tot} decided={tot-amb} sign_agreement={agree/(tot-amb)*100:.3f}% "
      f"max_abs_margin_diff_mm={md*1000:.2f} within_raster_tolerance_excluded={amb}")
