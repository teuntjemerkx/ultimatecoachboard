import math, random, numpy as np, overlap as o

def boundary_points(verts, step=0.001):
    pts = []
    for foot in (verts[:4], verts[4:]):
        # vertex order from foot_vertices: (a,b) in (-1,-1),(-1,1),(1,-1),(1,1) -> reorder to a loop
        loop = [foot[0], foot[1], foot[3], foot[2]]
        for i in range(4):
            p, q = np.array(loop[i]), np.array(loop[(i + 1) % 4])
            n = max(2, int(np.linalg.norm(q - p) / step) + 1)
            t = np.linspace(0, 1, n)[:, None]
            pts.append(p + t * (q - p))
    return np.vstack(pts)

def brute(team, stances, serving=False):
    ex = {}
    for p, xy in team.items():
        b = boundary_points(o.foot_vertices(*xy, stances[p]))
        ex[p] = (b[:, 1].min(), b[:, 0].min(), (9.0 - b[:, 0]).min())
    out = []
    for a, bb, k in o.PAIRS:
        if serving and "P1" in (a, bb):
            continue
        i = {"fb": 0, "left": 1, "right": 2}[k]
        out.append(ex[bb][i] - ex[a][i])
    return out

random.seed(7)
N = 20000
agree = total = 0
maxdiff = 0.0
near = 0
for n in range(N):
    cl, cd = random.uniform(1.5, 7.5), random.uniform(1.0, 7.5)
    team = {p: (cl + random.uniform(-0.8, 0.8), cd + random.uniform(-0.8, 0.8)) for p in ("P1","P2","P3","P4","P5","P6")}
    st = {p: o.Stance(yaw=math.radians(random.uniform(-60, 60)), width=random.uniform(0.2, 0.45),
                      stagger=random.uniform(-0.25, 0.25)) for p in team}
    serving = random.random() < 0.5
    a = [m for *_, m in o.evaluate(team, serving, st)]
    b = brute(team, st, serving)
    for x, y in zip(a, b):
        total += 1
        maxdiff = max(maxdiff, abs(x - y))
        if (x > 0) == (y > 0):
            agree += 1
        if abs(x) < 0.01:
            near += 1
print(f"formations={N} constraints={total} sign_agreement={agree/total*100:.4f}% "
      f"max_margin_diff_mm={maxdiff*1000:.3f} constraints_within_1cm_of_boundary={near}")
