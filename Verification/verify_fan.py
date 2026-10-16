import numpy as np
g, rb = 9.81, 0.105
RHO_A_2M = 1.2 * np.pi * rb**2 / (2 * 0.27)          # ~0.077 1/m
CD, CL = 0.25, 0.15
kD, kL = RHO_A_2M * CD, RHO_A_2M * CL
HNET = 2.43
UP = np.array([0., 1., 0.])

def simulate(p0, v0vec, dt=0.001):
    """RK4 with gravity, quadratic drag and topspin Magnus (spin axis fixed, horizontal, perpendicular to launch)."""
    fh = v0vec.copy(); fh[1] = 0; fh /= np.linalg.norm(fh)
    w = np.cross(UP, fh)                               # topspin axis: (w x v) points down for forward v
    def acc(v):
        s = np.linalg.norm(v)
        return np.array([0, -g, 0]) - kD * s * v + kL * s * np.cross(w, v)
    p, v, t = p0.copy(), v0vec.copy(), 0.0
    net_y = None
    while p[1] > rb and t < 3:
        k1v = acc(v); k1p = v
        k2v = acc(v + dt/2*k1v); k2p = v + dt/2*k1v
        k3v = acc(v + dt/2*k2v); k3p = v + dt/2*k2v
        k4v = acc(v + dt*k3v); k4p = v + dt*k3v
        pn = p + dt/6*(k1p + 2*k2p + 2*k3p + k4p); vn = v + dt/6*(k1v + 2*k2v + 2*k3v + k4v)
        if net_y is None and p[2] < 0 <= pn[2]:
            a = -p[2] / (pn[2] - p[2]); net_y = p[1] + a * (pn[1] - p[1])
        p, v, t = pn, vn, t + dt
    return p, net_y

def closed_form(P, L, v0, drag=True):
    dxz = np.array([L[0] - P[0], L[2] - P[2]]); D = np.linalg.norm(dxz); Delta = P[1] - rb
    vbar = v0 * (1 - np.exp(-kD * D)) / (kD * D) if drag else v0
    ge = g + kL * vbar**2
    disc = vbar**4 - ge * (ge * D**2 - 2 * Delta * vbar**2)
    if disc < 0: return None
    th = np.arctan((vbar**2 - np.sqrt(disc)) / (ge * D))
    # predicted net-crossing height on the approximate parabola
    dnet = D * (0 - P[2]) / (L[2] - P[2]) if L[2] != P[2] else 0
    ynet = P[1] + dnet * np.tan(th) - ge * dnet**2 / (2 * vbar**2 * np.cos(th)**2)
    return th, dxz / D, ynet

rng = np.random.default_rng(5)
P = np.array([0.0, 3.0, -0.6])                         # attack contact 3.0 m high, 0.6 m behind the net
rows = {"no drag": [], "drag": []}; clsagree = {"no drag": [0, 0], "drag": [0, 0]}; refined = []
for n in range(1500):
    L = np.array([rng.uniform(-4.4, 4.4), rb, rng.uniform(1.0, 8.9)])
    v0 = rng.uniform(18, 30)
    for mode in rows:
        cf = closed_form(P, L, v0, drag=(mode == "drag"))
        if cf is None: continue
        th, dirxz, ynet_pred = cf
        v0vec = v0 * np.array([dirxz[0]*np.cos(th), np.sin(th), dirxz[1]*np.cos(th)])
        land, ynet = simulate(P, v0vec)
        rows[mode].append(np.linalg.norm(land[[0, 2]] - L[[0, 2]]))
        if ynet is not None:
            clsagree[mode][0] += ((ynet_pred > HNET + rb) == (ynet > HNET + rb)); clsagree[mode][1] += 1
        if mode == "drag":
            # two secant iterations on the launch angle, the idle-time refinement
            def miss(a):
                vv = v0 * np.array([dirxz[0]*np.cos(a), np.sin(a), dirxz[1]*np.cos(a)])
                lp, _ = simulate(P, vv); return np.dot(lp[[0, 2]] - L[[0, 2]], dirxz)
            a0, a1 = th, th - 0.02; m0, m1 = miss(a0), miss(a1)
            for _ in range(2):
                if m1 == m0: break
                a2 = a1 - m1 * (a1 - a0) / (m1 - m0); a0, m0, a1, m1 = a1, m1, a2, miss(a2)
            refined.append(abs(m1))
for mode, r in rows.items():
    r = np.array(r)
    print(f"{mode:8s}: n={len(r)} landing error m median={np.median(r):.2f} p90={np.percentile(r,90):.2f} max={r.max():.2f} | "
          f"net-clear classification agreement={clsagree[mode][0]/clsagree[mode][1]*100:.1f}%")
r = np.array(refined); print(f"after 2 secant steps: landing error median={np.median(r)*100:.1f} cm p90={np.percentile(r,90)*100:.1f} cm max={r.max()*100:.1f} cm")
