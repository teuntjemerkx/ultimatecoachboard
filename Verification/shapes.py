"""Reference Smart Geometry recognizer (Section 3.5.3) + synthetic hand-drawn stroke generator."""
import numpy as np
from scipy.spatial import ConvexHull
from scipy.optimize import least_squares

N = 64
def resample(pts, n=N):
    pts = np.asarray(pts, float)
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1); s = np.r_[0, np.cumsum(seg)]
    t = np.linspace(0, s[-1], n)
    return np.c_[np.interp(t, s, pts[:, 0]), np.interp(t, s, pts[:, 1])], s[-1]

def dist_to_polyline(p, poly, closed=True):
    P = poly if not closed else np.vstack([poly, poly[:1]])
    best = np.full(len(p), np.inf)
    for a, b in zip(P[:-1], P[1:]):
        ab = b - a; L2 = ab @ ab
        t = np.clip(((p - a) @ ab) / (L2 if L2 > 0 else 1), 0, 1)
        best = np.minimum(best, np.linalg.norm(p - (a + t[:, None] * ab), axis=1))
    return best

def fit_line(p):
    c = p.mean(0); u = np.linalg.svd(p - c)[2][0]
    d = np.abs((p - c) @ np.array([-u[1], u[0]])); return dict(kind="line", c=c, u=u), np.sqrt(np.mean(d**2)), 4

def fit_circle(p):
    A = np.c_[2*p, np.ones(len(p))]; b = (p**2).sum(1)
    x = np.linalg.lstsq(A, b, rcond=None)[0]; c = x[:2]; r = np.sqrt(x[2] + c @ c)
    sol = least_squares(lambda q: np.linalg.norm(p - q[:2], axis=1) - q[2], np.r_[c, r])
    c, r = sol.x[:2], abs(sol.x[2]); res = np.linalg.norm(p - c, axis=1) - r
    return dict(kind="circle", c=c, r=r), np.sqrt(np.mean(res**2)), 3

def fit_ellipse(p):
    m = p.mean(0); s = np.abs(p - m).max(); q = (p - m) / s
    x, y = q[:, 0], q[:, 1]
    D1 = np.c_[x*x, x*y, y*y]; D2 = np.c_[x, y, np.ones_like(x)]
    S1, S2, S3 = D1.T @ D1, D1.T @ D2, D2.T @ D2
    try: T = -np.linalg.solve(S3, S2.T)
    except np.linalg.LinAlgError: return None, np.inf, 5
    M = S1 + S2 @ T; M = np.array([M[2] / 2, -M[1], M[0] / 2])
    w, v = np.linalg.eig(M); v = np.real(v)
    cond = 4 * v[0] * v[2] - v[1]**2
    idx = np.where(cond > 0)[0]
    if len(idx) == 0: return None, np.inf, 5
    a1 = v[:, idx[0]]; a, b, c = a1; d, e, f = T @ a1
    den = b*b - 4*a*c
    x0 = (2*c*d - b*e) / den; y0 = (2*a*e - b*d) / den
    num = 2 * (a*e*e + c*d*d - b*d*e + den * f)
    root = np.sqrt((a - c)**2 + b*b)
    ax1 = np.sqrt(max(num * (a + c + root), 0)) / abs(den); ax2 = np.sqrt(max(num * (a + c - root), 0)) / abs(den)
    ang = 0.5 * np.arctan2(-b, c - a)
    cen = np.array([x0, y0]) * s + m; A_, B_ = ax1 * s, ax2 * s
    t = np.linspace(0, 2*np.pi, 256, endpoint=False)
    R = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
    poly = (R @ np.vstack([A_ * np.cos(t), B_ * np.sin(t)])).T + cen
    d = dist_to_polyline(p, poly)
    return dict(kind="ellipse", c=cen, a=max(A_, B_), b=min(A_, B_), ang=ang), np.sqrt(np.mean(d**2)), 5

def min_area_rect(p):
    hull = p[ConvexHull(p).vertices]; best = None
    for i in range(len(hull)):
        e = hull[(i + 1) % len(hull)] - hull[i]; th = np.arctan2(e[1], e[0])
        R = np.array([[np.cos(th), np.sin(th)], [-np.sin(th), np.cos(th)]]); q = hull @ R.T
        lo, hi = q.min(0), q.max(0); area = np.prod(hi - lo)
        if best is None or area < best[0]: best = (area, th, lo, hi)
    _, th, lo, hi = best
    corners = np.array([[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]])
    R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
    return corners @ R.T

def fit_rect(p):
    c = min_area_rect(p); d = dist_to_polyline(p, c)
    return dict(kind="rect", corners=c), np.sqrt(np.mean(d**2)), 5

def rdp(p, eps):
    if len(p) < 3: return p
    a, b = p[0], p[-1]; ab = b - a; L = np.linalg.norm(ab)
    d = np.abs(ab[0] * (p[:, 1] - a[1]) - ab[1] * (p[:, 0] - a[0])) / L if L > 0 else np.linalg.norm(p - a, axis=1)
    i = int(np.argmax(d))
    if d[i] > eps: return np.vstack([rdp(p[:i+1], eps)[:-1], rdp(p[i:], eps)])
    return np.vstack([a, b])

def fit_polygon(p, diag):
    # rotate start to the sharpest turn so a corner is not split by the stroke start
    q = rdp(np.vstack([p, p[:1]]), 0.06 * diag)[:-1]
    # merge vertices closer than 8% of the diagonal
    keep = [q[0]]
    for v in q[1:]:
        if np.linalg.norm(v - keep[-1]) > 0.08 * diag: keep.append(v)
    if len(keep) > 2 and np.linalg.norm(keep[0] - keep[-1]) < 0.08 * diag: keep.pop()
    poly = np.array(keep)
    if len(poly) < 3: return None, np.inf, 99
    d = dist_to_polyline(p, poly)
    return dict(kind=f"polygon{len(poly)}", poly=poly), np.sqrt(np.mean(d**2)), 2 * len(poly)

def recognize(stroke, lam=0.004, tau=0.08, close_gap=0.15):
    p, L = resample(stroke); diag = np.linalg.norm(p.max(0) - p.min(0))
    closed = np.linalg.norm(p[-1] - p[0]) / L < close_gap
    if not closed:
        m, r, k = fit_line(p)
        return ("line" if r / diag < 0.03 else "open-freeform"), {}
    cands = [fit_circle(p), fit_ellipse(p), fit_rect(p), fit_polygon(p, diag)]
    scored = [(r / diag + lam * k, m, r) for m, r, k in cands if m is not None and np.isfinite(r)]
    s, m, r = min(scored, key=lambda x: x[0])
    if r / diag > tau: return "freeform", {}
    kind = m["kind"]
    if kind.startswith("polygon"): kind = "polygon"
    return kind, m

# ---------------- synthetic hand-drawn strokes ----------------
def ideal(kind, rng):
    t = np.linspace(0, 1, 400, endpoint=False)
    if kind == "circle":
        r = rng.uniform(0.6, 2.5); P = np.c_[r*np.cos(2*np.pi*t), r*np.sin(2*np.pi*t)]
    elif kind == "ellipse":
        a = rng.uniform(1.0, 3.0); b = a / rng.uniform(1.5, 2.6); P = np.c_[a*np.cos(2*np.pi*t), b*np.sin(2*np.pi*t)]
    elif kind == "rect":
        w, h = rng.uniform(1.0, 4.0), rng.uniform(1.0, 4.0)
        c = np.array([[-w/2, -h/2], [w/2, -h/2], [w/2, h/2], [-w/2, h/2], [-w/2, -h/2]])
        s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(c, axis=0), axis=1))]; tt = t * s[-1]
        P = np.c_[np.interp(tt, s, c[:, 0]), np.interp(tt, s, c[:, 1])]
    elif kind == "polygon":
        n = rng.choice([3, 5, 6]); ang = np.sort(rng.uniform(0, 2*np.pi, n)) if False else np.linspace(0, 2*np.pi, n, endpoint=False) + rng.uniform(-0.25, 0.25, n)
        rad = rng.uniform(1.2, 2.5) * rng.uniform(0.8, 1.2, n)
        c = np.c_[rad*np.cos(ang), rad*np.sin(ang)]; c = np.vstack([c, c[:1]])
        s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(c, axis=0), axis=1))]; tt = t * s[-1]
        P = np.c_[np.interp(tt, s, c[:, 0]), np.interp(tt, s, c[:, 1])]
    elif kind == "freeform":
        k = np.arange(1, 6); amp = rng.uniform(0.15, 0.45, 5) / k; ph = rng.uniform(0, 2*np.pi, 5)
        r = 2.0 * (1 + (amp[:, None] * np.cos(k[:, None] * 2*np.pi*t + ph[:, None])).sum(0))
        P = np.c_[r*np.cos(2*np.pi*t), r*np.sin(2*np.pi*t)]
    elif kind == "line":
        L = rng.uniform(1.5, 6); P = np.c_[t * L, np.zeros_like(t)]
    th = rng.uniform(0, 2*np.pi); R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
    return P @ R.T

def handdrawn(kind, rng):
    P = ideal(kind, rng); n = len(P)
    if kind != "line":
        start = rng.integers(n); P = np.roll(P, -start, axis=0)
        over = rng.uniform(-0.08, 0.15)                      # undershoot or overshoot at closure
        m = int(n * (1 + over)); idx = np.arange(m) % n; P = P[idx]
    size = np.linalg.norm(P.max(0) - P.min(0))
    t = np.linspace(0, 1, len(P))
    wob = sum(rng.uniform(0.005, 0.02) * size * np.c_[np.sin(2*np.pi*f*t + rng.uniform(0, 6)), np.cos(2*np.pi*f*t + rng.uniform(0, 6))] for f in (1, 2, 3))
    jit = rng.normal(0, 0.004 * size, P.shape)
    Q = P + wob + jit
    k = 9 if kind in ("rect", "polygon") else 3             # corner rounding by a short moving average
    Q = np.vstack([np.convolve(Q[:, i], np.ones(k) / k, mode="valid") for i in range(2)]).T
    keep = np.sort(rng.choice(len(Q), size=int(len(Q) * rng.uniform(0.3, 0.7)), replace=False))   # uneven pen speed
    return Q[keep]

# ---------------- revised recognizer: corner-gated model selection ----------------
def corners_closed(p, w=3, min_angle=40.0, ratio=2.2):
    n = len(p) - 1 if np.allclose(p[0], p[-1]) else len(p)
    q = p[:n]
    a = q - np.roll(q, w, axis=0); b = np.roll(q, -w, axis=0) - q
    ang = np.degrees(np.abs(np.arctan2(a[:, 0]*b[:, 1] - a[:, 1]*b[:, 0], (a*b).sum(1))))
    med = np.median(ang)
    idx = [i for i in range(n) if ang[i] >= max(min_angle, ratio * med)
           and ang[i] >= ang[(i - 1) % n] and ang[i] >= ang[(i + 1) % n]]
    merged = []                                   # merge peaks closer than w samples
    for i in idx:
        if merged and (i - merged[-1]) <= w: 
            if ang[i] > ang[merged[-1]]: merged[-1] = i
        else: merged.append(i)
    if len(merged) > 1 and (merged[0] + n - merged[-1]) <= w: merged.pop()
    return q[merged], ang, med

def recognize2(stroke, tau_round=0.045, tau_poly=0.05, close_gap=0.15, circ_ratio=1.25):
    p, L = resample(stroke); diag = np.linalg.norm(p.max(0) - p.min(0))
    if np.linalg.norm(p[-1] - p[0]) / L >= close_gap:
        _, r, _ = fit_line(p)
        return ("line" if r / diag < 0.03 else "open-freeform"), {}
    cs, ang, med = corners_closed(p)
    nc = len(cs)
    if nc >= 3:
        rect, rr, _ = fit_rect(p)
        poly = cs
        rp = np.sqrt(np.mean(dist_to_polyline(p, poly)**2))
        if nc in (3, 4, 5) and rr / diag < tau_poly:
            # rectangle if its fit is as good as the polygon through the detected corners
            if nc == 4 or rr <= 1.15 * rp: return "rect", rect
        if rp / diag < tau_poly: return "polygon", dict(poly=poly)
        return "freeform", {}
    circ, rc, _ = fit_circle(p); ell, re, _ = fit_ellipse(p)
    if ell is not None and ell["a"] / max(ell["b"], 1e-9) > circ_ratio and re / diag < tau_round: return "ellipse", ell
    if rc / diag < tau_round: return "circle", circ
    if ell is not None and re / diag < tau_round: return "ellipse", ell
    return "freeform", {}

def ideal_freeform_lobed(rng):
    t = np.linspace(0, 1, 400, endpoint=False); r = 2.0 * np.ones_like(t)
    r += rng.uniform(0.0, 0.25) * np.cos(2 * 2*np.pi*t + rng.uniform(0, 6))
    for k in (3, 4, 5): r += rng.uniform(0.08, 0.2) * 2.0 * np.cos(k * 2*np.pi*t + rng.uniform(0, 6)) / (k - 1)
    P = np.c_[r*np.cos(2*np.pi*t), r*np.sin(2*np.pi*t)]
    th = rng.uniform(0, 2*np.pi); R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
    return P @ R.T

# ---------------- v3: local-contrast corners + domain-representative test shapes ----------------
def corners_v3(p, w=3, min_angle=45.0, contrast=2.0):
    q = p[:-1] if np.allclose(p[0], p[-1]) else p
    n = len(q)
    a = q - np.roll(q, w, axis=0); b = np.roll(q, -w, axis=0) - q
    ang = np.degrees(np.abs(np.arctan2(a[:, 0]*b[:, 1] - a[:, 1]*b[:, 0], (a*b).sum(1))))
    out = []
    for i in range(n):
        if ang[i] < min_angle or ang[i] < ang[(i-1) % n] or ang[i] < ang[(i+1) % n]: continue
        ring = [ang[(i + s) % n] for s in list(range(w + 2, w + 8)) + list(range(-w - 7, -w - 1))]
        if ang[i] >= contrast * (np.mean(ring) + 1e-6): out.append(i)
    merged = []
    for i in out:
        if merged and i - merged[-1] <= w:
            if ang[i] > ang[merged[-1]]: merged[-1] = i
        else: merged.append(i)
    if len(merged) > 1 and merged[0] + n - merged[-1] <= w: merged.pop(0)
    return q[merged]

def recognize3(stroke, tau_round=0.035, tau_poly=0.04, close_gap=0.15, circ_ratio=1.2, ambiguity=0.25):
    """Returns (label, params, alternative_or_None). An alternative is offered when the runner-up is close."""
    p, L = resample(stroke); diag = np.linalg.norm(p.max(0) - p.min(0))
    if np.linalg.norm(p[-1] - p[0]) / L >= close_gap:
        _, r, _ = fit_line(p)
        return ("line" if r / diag < 0.03 else "open-freeform"), {}, None
    cs = corners_v3(p); nc = len(cs)
    circ, rc, _ = fit_circle(p); ell, re, _ = fit_ellipse(p); rect, rr, _ = fit_rect(p)
    rc, re, rr = rc / diag, (re / diag if ell is not None else np.inf), rr / diag
    rp = np.sqrt(np.mean(dist_to_polyline(p, cs)**2)) / diag if nc >= 3 else np.inf
    cands = []
    if nc >= 3:
        if nc <= 5 and rr < tau_poly: cands.append(("rect", rr + 0.002 * 5))
        if rp < tau_poly: cands.append(("polygon", rp + 0.002 * 2 * nc))
    else:
        ratio = ell["a"] / max(ell["b"], 1e-9) if ell is not None else 1
        if rc < tau_round: cands.append(("circle", rc + 0.002 * 3 + (0.01 if ratio > circ_ratio else 0)))
        if re < tau_round: cands.append(("ellipse", re + 0.002 * 5))
    if not cands: return "freeform", {}, None
    cands.sort(key=lambda x: x[1])
    alt = cands[1][0] if len(cands) > 1 and cands[1][1] - cands[0][1] < ambiguity * cands[0][1] else None
    return cands[0][0], {}, alt

def ideal_v3(kind, rng):
    t = np.linspace(0, 1, 400, endpoint=False)
    def poly_from(c):
        c = np.vstack([c, c[:1]]); s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(c, axis=0), axis=1))]; tt = t * s[-1]
        return np.c_[np.interp(tt, s, c[:, 0]), np.interp(tt, s, c[:, 1])]
    if kind == "polygon":           # irregular triangles, trapezoids, quadrilaterals, pentagons
        n = rng.choice([3, 4, 5])
        ang = np.linspace(0, 2*np.pi, n, endpoint=False) + rng.uniform(-0.35, 0.35, n)
        rad = rng.uniform(1.5, 2.5) * rng.uniform(0.65, 1.3, n)
        P = poly_from(np.c_[rad*np.cos(ang), rad*np.sin(ang)])
        if n == 4:                  # make quads clearly non-rectangular (trapezoid / kite)
            c = np.array([[-2, -1.2], [2, -1.2], [1.0 + rng.uniform(-0.4, 0.4), 1.2], [-1.0 + rng.uniform(-0.4, 0.4), 1.2]]) * rng.uniform(0.6, 1.2)
            P = poly_from(c)
    elif kind == "freeform":        # beans and blobs with a visible concavity
        r = 2.0 + rng.uniform(0.35, 0.6) * np.cos(2*2*np.pi*t + rng.uniform(0, 6)) + rng.uniform(0.25, 0.45) * np.cos(3*2*np.pi*t + rng.uniform(0, 6))
        P = np.c_[r*np.cos(2*np.pi*t), r*np.sin(2*np.pi*t)]
    else:
        return ideal(kind, rng)
    th = rng.uniform(0, 2*np.pi); R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
    return P @ R.T

def handdrawn_v3(kind, rng, wobble=(0.003, 0.012)):
    P = ideal_v3(kind, rng); n = len(P)
    if kind != "line":
        P = np.roll(P, -rng.integers(n), axis=0); m = int(n * (1 + rng.uniform(-0.08, 0.15))); P = P[np.arange(m) % n]
    size = np.linalg.norm(P.max(0) - P.min(0)); t = np.linspace(0, 1, len(P))
    wob = sum(rng.uniform(*wobble) * size * np.c_[np.sin(2*np.pi*f*t + rng.uniform(0, 6)), np.cos(2*np.pi*f*t + rng.uniform(0, 6))] for f in (1, 2, 3))
    Q = P + wob + rng.normal(0, 0.003 * size, P.shape)
    k = 7 if kind in ("rect", "polygon") else 3
    Q = np.vstack([np.convolve(Q[:, i], np.ones(k) / k, mode="valid") for i in range(2)]).T
    return Q[np.sort(rng.choice(len(Q), size=int(len(Q) * rng.uniform(0.3, 0.7)), replace=False))]

# ---------------- v4: all candidates scored, corner evidence as a prior ----------------
def polygon_vertices(p, diag, cs, eps=0.04, merge=0.08, max_n=6):
    q = rdp(np.vstack([p, p[:1]]), eps * diag)[:-1]
    pts = list(cs) + list(q)
    # order around the centroid and merge near-duplicates
    c = p.mean(0); pts = sorted(pts, key=lambda v: np.arctan2(v[1] - c[1], v[0] - c[0]))
    out = []
    for v in pts:
        if not out or np.linalg.norm(v - out[-1]) > merge * diag: out.append(np.asarray(v))
    if len(out) > 2 and np.linalg.norm(out[0] - out[-1]) < merge * diag: out.pop()
    # drop vertices whose interior angle is nearly straight (< 15 deg of turn)
    changed = True
    while changed and len(out) > 3:
        changed = False
        for i in range(len(out)):
            a, b, d = out[i - 1], out[i], out[(i + 1) % len(out)]
            u, v = b - a, d - b
            turn = np.degrees(abs(np.arctan2(u[0]*v[1] - u[1]*v[0], u @ v)))
            if turn < 15: out.pop(i); changed = True; break
    return np.array(out) if 3 <= len(out) <= max_n else None

def quad_is_rect(poly, tol=15):
    if poly is None or len(poly) != 4: return False
    for i in range(4):
        u, v = poly[i - 1] - poly[i], poly[(i + 1) % 4] - poly[i]
        if abs(np.degrees(np.arccos(np.clip(u @ v / (np.linalg.norm(u) * np.linalg.norm(v)), -1, 1))) - 90) > tol: return False
    return True

def recognize4(stroke, tau=0.035, close_gap=0.15, circle_ratio=1.3, prior=0.012, k=0.002, ambiguity=0.15):
    p, L = resample(stroke); diag = np.linalg.norm(p.max(0) - p.min(0))
    if np.linalg.norm(p[-1] - p[0]) / L >= close_gap:
        _, r, _ = fit_line(p)
        return ("line" if r / diag < 0.03 else "open-freeform"), {}, None
    cs = corners_v3(p); cornered = len(cs) >= 3
    circ, rc, _ = fit_circle(p); ell, re, _ = fit_ellipse(p); rect, rr, _ = fit_rect(p)
    poly = polygon_vertices(p, diag, cs)
    rp = np.sqrt(np.mean(dist_to_polyline(p, poly)**2)) if poly is not None else np.inf
    ratio = ell["a"] / max(ell["b"], 1e-9) if ell is not None else 1.0
    c = []
    if ratio < circle_ratio: c.append(("circle", rc / diag + 3 * k + (prior if cornered else 0)))
    else: c.append(("ellipse", (re / diag if ell is not None else np.inf) + 5 * k + (prior if cornered else 0)))
    rect_ok = quad_is_rect(poly) or (poly is not None and len(poly) == 4 and rr <= 1.6 * rp)
    if rect_ok or poly is None: c.append(("rect", rr / diag + 5 * k + (0 if cornered else prior)))
    if poly is not None and not (len(poly) == 4 and quad_is_rect(poly)):
        c.append(("polygon", rp / diag + 2 * len(poly) * k + (0 if cornered else prior)))
    c = [x for x in c if np.isfinite(x[1])]
    c.sort(key=lambda x: x[1])
    if not c or c[0][1] > tau: return "freeform", {}, (c[0][0] if c and c[0][1] < 1.4 * tau else None)
    alt = c[1][0] if len(c) > 1 and c[1][1] - c[0][1] < ambiguity * c[0][1] else None
    if alt is None and c[0][1] > 0.85 * tau: alt = "freeform"
    return c[0][0], {}, alt
