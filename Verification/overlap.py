"""Executable reference of the overlap engine (Section 3.4) in the team-local frame (l, d)."""
import math
from dataclasses import dataclass

FOOT_LEN, FOOT_W = 0.28, 0.10

@dataclass
class Stance:
    yaw: float = 0.0        # 0 = facing the net (forward = -d)
    width: float = 0.30     # centre-to-centre lateral foot spacing
    stagger: float = 0.0    # +: left foot forward

def foot_vertices(cl, cd, st: Stance):
    """Return the 8 vertices (two 0.28 x 0.10 rectangles) of a player's feet."""
    fwd = (math.sin(st.yaw), -math.cos(st.yaw))        # unit forward in (l, d)
    rgt = (math.cos(st.yaw), math.sin(st.yaw))         # unit right
    verts = []
    for side, stag in ((-1, st.stagger / 2), (1, -st.stagger / 2)):
        fl = cl + rgt[0] * side * st.width / 2 + fwd[0] * stag
        fd = cd + rgt[1] * side * st.width / 2 + fwd[1] * stag
        for a in (-1, 1):
            for b in (-1, 1):
                verts.append((fl + fwd[0] * a * FOOT_LEN / 2 + rgt[0] * b * FOOT_W / 2,
                              fd + fwd[1] * a * FOOT_LEN / 2 + rgt[1] * b * FOOT_W / 2))
    return verts

def extremes(verts):
    D = min(v[1] for v in verts)
    LL = min(v[0] for v in verts)
    LR = min(9.0 - v[0] for v in verts)
    return D, LL, LR

PAIRS = [("P4", "P5", "fb"), ("P3", "P6", "fb"), ("P2", "P1", "fb"),
         ("P4", "P3", "left"), ("P5", "P6", "left"),
         ("P2", "P3", "right"), ("P1", "P6", "right")]

def evaluate(team, serving=False, stances=None):
    """team: {pos: (l, d)}; returns list of (a, b, kind, margin)."""
    stances = stances or {}
    ex = {p: extremes(foot_vertices(*xy, stances.get(p, Stance()))) for p, xy in team.items()}
    out = []
    for a, b, k in PAIRS:
        if serving and "P1" in (a, b):
            continue
        if k == "fb":
            m = ex[b][0] - ex[a][0]
        elif k == "left":
            m = ex[b][1] - ex[a][1]
        else:
            m = ex[b][2] - ex[a][2]
        out.append((a, b, k, m))
    return out

def legal(team, serving=False, stances=None):
    return all(m > 0 for *_, m in evaluate(team, serving, stances))
