"""Deterministic strokes shared by the Python reference and the Swift unit tests."""
import numpy as np, shapes as S
def poly_path(c, n, over):
    c = np.vstack([c, c[:1]]); s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(c, axis=0), axis=1))]
    t = np.linspace(0, 1 + over, n) % 1.0 * s[-1]
    return np.c_[np.interp(t, s, c[:, 0]), np.interp(t, s, c[:, 1])]
def rot(P, th): R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]]); return P @ R.T
def wobble(P, amp):
    n = len(P); t = np.linspace(0, 1, n)
    return P + amp * np.c_[np.sin(2*np.pi*3*t + 0.5), np.cos(2*np.pi*2*t + 1.1)]
N = 180
def strokes():
    t = np.linspace(0, 2*np.pi*1.05, N) + 0.3
    yield "circle", wobble(np.c_[2*np.cos(t), 2*np.sin(t)], 0.03)
    yield "ellipse", wobble(rot(np.c_[3*np.cos(t), 1.4*np.sin(t)], 0.4), 0.03)
    yield "rect", wobble(rot(poly_path(np.array([[-2, -1.25], [2, -1.25], [2, 1.25], [-2, 1.25]]), N, 0.06), 0.2), 0.02)
    yield "polygon", wobble(poly_path(np.array([[-2.0, -1.5], [2.5, -1.0], [-0.3, 2.2]]), N, 0.06), 0.02)
    yield "polygon", wobble(poly_path(np.array([[-2.0, -1.2], [2.0, -1.2], [1.0, 1.2], [-1.2, 1.2]]), N, 0.06), 0.02)
    tb = np.linspace(0, 2*np.pi*1.04, N)
    r = 2 + 0.5*np.cos(2*tb) + 0.4*np.cos(3*tb + 1)
    yield "freeform", np.c_[r*np.cos(tb), r*np.sin(tb)]
    s = np.linspace(0, 1, N)
    yield "line", wobble(np.c_[5*s, 0.4*s], 0.01)
    ta = np.linspace(0, np.pi, N)
    yield "openPath", np.c_[2*np.cos(ta), 2*np.sin(ta)]
for name, P in strokes():
    k, m, alt = S.recognize4(P, tau=0.035, prior=0.008, circle_ratio=1.25)
    k = {"open-freeform": "openPath"}.get(k, k)
    print(f"{name:9s} -> {k:9s} alt={alt}")
