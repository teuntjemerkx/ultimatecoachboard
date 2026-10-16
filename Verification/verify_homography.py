import numpy as np
rng = np.random.default_rng(3)
W, H = 1920, 1080
FLOOR = np.array([[x, z] for x in (-4.5, 4.5) for z in (-9, -3, 0, 3, 9)], float)  # corners, attack & centre line ends

def look_at(C, target):
    f = target - C; f /= np.linalg.norm(f)                  # camera +z looks forward (OpenCV convention)
    r = np.cross(f, [0, 1, 0]); r /= np.linalg.norm(r)        # image x to the right
    d = np.cross(f, r)                                        # image y down
    return np.stack([r, d, f])                                # rows: camera axes in world -> R (world->cam)

def dlt(src, dst):
    def norm(p):
        m = p.mean(0); s = np.sqrt(2) / np.mean(np.linalg.norm(p - m, axis=1))
        T = np.array([[s, 0, -s*m[0]], [0, s, -s*m[1]], [0, 0, 1]]); return T, (np.c_[p, np.ones(len(p))] @ T.T)
    Ts, s = norm(src); Td, d = norm(dst); A = []
    for (x, y, _), (u, v, _) in zip(s, d):
        A += [[-x, -y, -1, 0, 0, 0, u*x, u*y, u], [0, 0, 0, -x, -y, -1, v*x, v*y, v]]
    Hn = np.linalg.svd(np.array(A))[2][-1].reshape(3, 3)
    return np.linalg.inv(Td) @ Hn @ Ts

def focal_from_H(Hc):
    h1, h2 = Hc[:, 0], Hc[:, 1]
    est, wts = [], []
    den1 = h1[2]*h2[2]
    if abs(den1) > 1e-12:
        f2 = -(h1[0]*h2[0] + h1[1]*h2[1]) / den1
        if f2 > 0: est.append(np.sqrt(f2)); wts.append(den1**2)
    den2 = h2[2]**2 - h1[2]**2
    if abs(den2) > 1e-12:
        f2 = (h1[0]**2 + h1[1]**2 - h2[0]**2 - h2[1]**2) / den2
        if f2 > 0: est.append(np.sqrt(f2)); wts.append(den2**2)
    if not est: return None
    return float(np.average(est, weights=wts))

def pose_from_H(Hc, f):
    Kinv = np.diag([1/f, 1/f, 1])
    a, b, c = Kinv @ Hc[:, 0], Kinv @ Hc[:, 1], Kinv @ Hc[:, 2]
    lam = 1 / np.linalg.norm(a)
    rX, rZ, t = lam*a, lam*b, lam*c
    rY = np.cross(rZ, rX)
    U, _, Vt = np.linalg.svd(np.stack([rX, rY, rZ], 1)); R = U @ Vt
    if np.linalg.det(R) < 0: R = -R
    C = -R.T @ t
    if C[1] < 0:   # camera below the floor: flip the sign of lambda
        rX, rZ, t = -rX, -rZ, -t; rY = np.cross(rZ, rX)
        U, _, Vt = np.linalg.svd(np.stack([rX, rY, rZ], 1)); R = U @ Vt; C = -R.T @ t
    return R, C

res = {"bleachers": [], "baseline": []}
fail = {"bleachers": 0, "baseline": 0}
for view in res:
    for trial in range(2000):
        f = rng.uniform(900, 2600)
        if view == "bleachers":
            C = np.array([-(4.5 + rng.uniform(5, 14)), rng.uniform(2.5, 9), rng.uniform(-6, 6)])
            tgt = np.array([rng.uniform(-1.5, 1.5), 0, rng.uniform(-3, 3)])
        else:
            C = np.array([rng.uniform(-3, 3), rng.uniform(1.6, 7), 9 + rng.uniform(4, 12)])
            tgt = np.array([rng.uniform(-1, 1), 0, rng.uniform(-2, 2)])
        R = look_at(C, tgt); t = -R @ C
        K = np.array([[f, 0, W/2], [0, f, H/2], [0, 0, 1]])
        P3 = np.c_[FLOOR[:, 0], np.zeros(len(FLOOR)), FLOOR[:, 1]]
        cam = (R @ P3.T).T + t
        ok = cam[:, 2] > 0.5
        uv = (K @ cam.T).T; uv = uv[:, :2] / uv[:, 2:3]
        ok &= (uv[:, 0] > 0) & (uv[:, 0] < W) & (uv[:, 1] > 0) & (uv[:, 1] < H)
        if ok.sum() < 5: continue
        uvn = uv[ok] + rng.normal(0, 0.7, (ok.sum(), 2))
        Hh = dlt(FLOOR[ok], uvn)
        Hc = np.array([[1, 0, -W/2], [0, 1, -H/2], [0, 0, 1]]) @ Hh     # centred pixel coordinates
        fe = focal_from_H(Hc)
        if fe is None or not np.isfinite(fe): fail[view] += 1; continue
        Re, Ce = pose_from_H(Hc, fe)
        ang = np.degrees(np.arccos(np.clip((np.trace(Re.T @ R) - 1) / 2, -1, 1)))
        res[view].append((abs(fe - f) / f * 100, np.linalg.norm(Ce - C), ang, ok.sum()))
for view, r in res.items():
    r = np.array(r)
    print(f"{view}: n={len(r)} focal_err% median={np.median(r[:,0]):.2f} p95={np.percentile(r[:,0],95):.2f} | "
          f"centre_err_m median={np.median(r[:,1]):.3f} p95={np.percentile(r[:,1],95):.3f} | rot_err_deg median={np.median(r[:,2]):.3f} "
          f"p95={np.percentile(r[:,2],95):.3f} | visible pts median={np.median(r[:,3]):.0f} | no-solution={fail[view]}")
