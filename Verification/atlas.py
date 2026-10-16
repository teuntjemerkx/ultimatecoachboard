import json, math, overlap as o

# ---------- timing model (Appendix A, A1) ----------
T_SERVE, T_PASS = 1.2, 1.1
T_SET = T_SERVE + T_PASS
START_NONPASSER, START_PASSER = 0.25, T_SERVE + 0.2
V_SETTER, V_RUN = 4.5, 5.0
TARGET = (6.0, 0.7)
DEST = {"left": (-0.3, 3.8), "right": (9.3, 3.8), "quick": (4.6, 3.0), "pipe": (4.5, 6.6), "dball": (7.8, 6.6),
        "target": TARGET}
DEADLINE = {"target": T_SET - 0.3, "left": T_SET + 0.8 - 0.75, "right": T_SET + 0.8 - 0.75,
            "quick": T_SET - 0.45, "pipe": T_SET + 0.7 - 0.75, "dball": T_SET + 0.7 - 0.75}

def route(start, kind, passer):
    if kind is None: return None
    dx, dy = DEST[kind][0] - start[0], DEST[kind][1] - start[1]
    L = math.hypot(dx, dy)
    v = V_SETTER if kind == "target" else V_RUN
    t = (START_PASSER if passer else START_NONPASSER) + L / v
    return dict(dest=kind, length=round(L, 2), arrive=round(t, 2), deadline=round(DEADLINE[kind], 2),
                slack=round(DEADLINE[kind] - t, 2))

def formation(name, players, serving=False):
    """players: list of (pos, role, l, d, passer, routeKind)"""
    team = {p: (l, d) for p, r, l, d, *_ in players}
    cons = o.evaluate(team, serving)
    rows = []
    for p, r, l, d, passer, kind in players:
        rows.append(dict(pos=p, role=r, l=l, d=d, passer=passer, route=route((l, d), kind, passer)))
    return dict(name=name, players=rows, constraints=[dict(a=a, b=b, kind=k, margin=round(m, 2)) for a, b, k, m in cons],
                legal=all(m > 0 for *_, m in cons), min_margin=round(min(m for *_, m in cons), 2))

F51 = [
 formation("5-1 R1 receive", [("P1","S",8.4,5.8,False,"target"),("P2","OH1",2.2,5.0,True,"left"),("P3","MB1",1.5,1.0,False,"quick"),
                              ("P4","OPP",0.7,0.6,False,"right"),("P5","OH2",4.5,5.4,True,"pipe"),("P6","L",7.0,5.0,True,None)]),
 formation("5-1 R6 receive", [("P1","OH1",7.0,5.0,True,"pipe"),("P2","MB1",7.6,0.6,False,"quick"),("P3","OPP",5.0,0.5,False,"right"),
                              ("P4","OH2",2.0,5.0,True,"left"),("P5","L",4.0,5.7,True,None),("P6","S",5.6,1.2,False,"target")]),
 formation("5-1 R5 receive", [("P1","L",7.0,5.0,True,None),("P2","OPP",8.0,0.6,False,"right"),("P3","OH2",2.0,5.0,True,"left"),
                              ("P4","MB2",1.2,0.6,False,"quick"),("P5","S",3.6,1.0,False,"target"),("P6","OH1",4.5,5.5,True,"pipe")]),
 formation("5-1 R4 receive", [("P1","OPP",8.3,7.6,False,"dball"),("P2","OH2",2.4,4.6,True,"left"),("P3","MB2",1.7,0.9,False,"quick"),
                              ("P4","S",0.9,0.5,False,"target"),("P5","OH1",4.6,5.1,True,"pipe"),("P6","L",6.9,5.0,True,None)]),
 formation("5-1 R3 receive", [("P1","OH2",7.0,5.0,True,"pipe"),("P2","MB2",7.2,0.6,False,"quick"),("P3","S",5.0,0.5,False,"target"),
                              ("P4","OH1",2.0,5.0,True,"left"),("P5","L",4.0,5.6,True,None),("P6","OPP",5.8,7.8,False,"dball")]),
 formation("5-1 R2 receive", [("P1","L",7.0,5.0,True,None),("P2","S",7.0,0.5,False,"target"),("P3","OH1",2.0,5.0,True,"left"),
                              ("P4","MB1",1.2,0.6,False,"quick"),("P5","OPP",1.0,8.0,False,"dball"),("P6","OH2",4.5,5.6,True,"pipe")]),
]
# 5-1 with the middle following the setter: lineup order S, MB1, OH1, OPP, MB2, OH2 (libero for the back-row middle)
F51M = [
 formation("5-1 MB R1 receive", [("P1","S",8.4,5.8,False,"target"),("P2","MB1",5.5,0.6,False,"quick"),("P3","OH1",2.0,4.8,True,"left"),
                                 ("P4","OPP",0.7,0.6,False,"right"),("P5","L",4.5,5.4,True,None),("P6","OH2",7.0,5.5,True,"pipe")]),
 formation("5-1 MB R6 receive", [("P1","L",7.0,5.3,True,None),("P2","OH1",2.4,4.6,True,"left"),("P3","OPP",1.4,0.6,False,"right"),
                                 ("P4","MB2",0.5,0.6,False,"quick"),("P5","OH2",4.2,5.4,True,"pipe"),("P6","S",5.8,1.2,False,"target")]),
 formation("5-1 MB R5 receive", [("P1","OH1",7.0,5.2,True,"pipe"),("P2","OPP",8.0,0.6,False,"right"),("P3","MB2",4.4,0.6,False,"quick"),
                                 ("P4","OH2",2.4,4.8,True,"left"),("P5","S",1.4,5.6,False,"target"),("P6","L",4.5,5.4,True,None)]),
 formation("5-1 MB R4 receive", [("P1","OPP",8.3,7.6,False,"dball"),("P2","MB2",5.0,0.6,False,"quick"),("P3","OH2",2.2,4.6,True,"left"),
                                 ("P4","S",0.9,0.5,False,"target"),("P5","L",4.2,5.3,True,None),("P6","OH1",7.0,5.4,True,"pipe")]),
 formation("5-1 MB R3 receive", [("P1","L",7.0,5.2,True,None),("P2","OH2",2.2,4.6,True,"left"),("P3","S",1.4,0.5,False,"target"),
                                 ("P4","MB1",0.5,0.6,False,"quick"),("P5","OH1",4.0,5.4,True,"pipe"),("P6","OPP",5.6,7.8,False,"dball")]),
 formation("5-1 MB R2 receive", [("P1","OH2",7.0,5.2,True,"pipe"),("P2","S",7.0,0.5,False,"target"),("P3","MB1",4.4,0.6,False,"quick"),
                                 ("P4","OH1",2.0,4.8,True,"left"),("P5","OPP",1.0,8.0,False,"dball"),("P6","L",4.5,5.5,True,None)]),
]
# counter-example for the validator: R1 with OH1 passing in the right lane
R1_BAD = formation("5-1 R1 receive, OH1 in right lane (rejected)", [("P1","S",8.4,5.8,False,"target"),("P2","OH1",7.0,5.0,True,"left"),
     ("P3","MB1",1.5,1.0,False,"quick"),("P4","OPP",0.7,0.6,False,"right"),("P5","OH2",2.0,5.0,True,"pipe"),("P6","L",4.5,5.4,True,None)])

F42 = [
 formation("4-2 pattern A (front setter in P4)", [("P1","S1",7.7,5.3,True,None),("P2","OH1",1.5,4.8,True,"left"),("P3","MB1",1.0,0.9,False,"quick"),
        ("P4","S2",0.4,0.5,False,"target"),("P5","OH2",3.4,5.5,True,None),("P6","MB2",5.6,5.5,True,None)]),
 formation("4-2 pattern B (front setter in P3)", [("P1","OH1",7.7,4.8,True,None),("P2","MB1",7.4,0.6,False,"quick"),("P3","S2",5.0,0.5,False,"target"),
        ("P4","OH2",1.3,4.8,True,"left"),("P5","MB2",3.4,5.5,True,None),("P6","S1",5.6,5.5,True,None)]),
 formation("4-2 pattern C (front setter in P2)", [("P1","MB1",7.7,4.8,True,None),("P2","S2",7.0,0.5,False,"target"),("P3","OH2",1.3,4.8,True,"left"),
        ("P4","MB2",0.6,0.6,False,"quick"),("P5","S1",3.4,5.5,True,None),("P6","OH1",5.6,5.5,True,None)]),
]
YOUTH_W = formation("Youth W, setter in P3", [("P1","E",6.0,6.6,True,None),("P2","B",7.5,4.2,True,None),("P3","C (setter)",4.5,0.6,False,None),
        ("P4","D",1.5,4.2,True,None),("P5","F",3.0,6.6,True,None),("P6","A",4.5,4.4,True,None)])

# ---------- serving formations + base defence for 5-1 ----------
BASE = {"LF": (1.0, 0.7), "MF": (4.5, 0.7), "RF": (8.0, 0.7), "LB": (1.2, 6.3), "MBK": (4.5, 8.0), "RB": (7.8, 6.3)}
def lineup(order, k):  # k side-outs after R1 -> {pos: role}
    return {f"P{i}": order[(i - 1 + k) % 6] for i in range(1, 7)}
names = ["R1","R6","R5","R4","R3","R2"]
def slot(role, front, serving_role):
    if front:
        return {"OH1":"LF","OH2":"LF","MB1":"MF","MB2":"MF","OPP":"RF","S":"RF"}[role]
    if role in ("S","OPP"): return "RB"
    if role in ("OH1","OH2"): return "MBK"
    return "LB"   # libero or serving middle
def pava_spaced(dest, gap):
    """Closest positions to dest (least squares) that keep rotational order with a minimum lateral gap."""
    z = [x - gap * i for i, x in enumerate(dest)]
    blocks = []  # [value, weight]
    for v in z:
        blocks.append([v, 1])
        while len(blocks) > 1 and blocks[-2][0] > blocks[-1][0]:
            v2, w2 = blocks.pop(); v1, w1 = blocks.pop()
            blocks.append([(v1 * w1 + v2 * w2) / (w1 + w2), w1 + w2])
    y = [b[0] for b in blocks for _ in range(b[1])]
    return [min(max(yy + gap * i, 0.3), 8.7) for i, yy in enumerate(y)]
def serve_formations(order, prefix):
    out = []
    for k, nm in enumerate(names):
        lu = lineup(order, k)
        server = lu["P1"]
        # libero replaces the back-row middle who is not serving
        for p in ("P5","P6","P1"):
            if lu[p] in ("MB1","MB2") and p != "P1": lu[p] = "L"
        rows, team = [], {}
        for row, poss, dep in (("front", ["P4","P3","P2"], 0.8), ("back", ["P5","P6"], 6.6)):
            dests = [BASE[slot(lu[p], row == "front", server)] for p in poss]
            xs = [dd[0] for dd in dests]
            ls = pava_spaced(xs, 0.8)
            for p, l, dd in zip(poss, ls, dests):
                dpos = dep if row == "front" else dd[1]
                l = math.floor(l * 10 + 0.5) / 10
                team[p] = (l, dpos)
                rows.append(dict(pos=p, role=lu[p], l=round(l, 2), d=dpos, switch_to=dd,
                                 switch_len=round(math.hypot(dd[0] - l, dd[1] - dpos), 2)))
        sb = BASE[slot(server, False, server)]
        sl = min(max(sb[0], 0.8), 8.2)
        team["P1"] = (sl, 10.0)
        rows.append(dict(pos="P1", role=server + " (serves)", l=sl, d=10.0, switch_to=sb, switch_len=round(math.hypot(sb[0]-sl, sb[1]-10.0), 2)))
        cons = o.evaluate(team, serving=True)
        out.append(dict(name=f"{prefix} {nm} serve", players=rows, legal=all(m > 0 for *_, m in cons),
                        min_margin=round(min(m for *_, m in cons), 2),
                        constraints=[dict(a=a, b=b, kind=kk, margin=round(m, 2)) for a, b, kk, m in cons]))
    return out
ORDER_OH = ["S","OH1","MB1","OPP","OH2","MB2"]
ORDER_MB = ["S","MB1","OH1","OPP","MB2","OH2"]
SERVE = serve_formations(ORDER_OH, "5-1")
SERVE_MB = serve_formations(ORDER_MB, "5-1 MB")

out = dict(timing=dict(T_SERVE=T_SERVE, T_PASS=T_PASS, T_SET=T_SET, deadlines=DEADLINE, dest=DEST),
           f51=F51, r1_bad=R1_BAD, f42=F42, youth=YOUTH_W, serve=SERVE, base=BASE,
           f51m=F51M, serve_mb=SERVE_MB)
json.dump(out, open("atlas.json", "w"), indent=1)
for f in F51 + [R1_BAD] + F42 + [YOUTH_W] + SERVE + F51M + SERVE_MB:
    late = [(p["role"], p["route"]["slack"]) for p in f["players"] if p.get("route") and p["route"]["slack"] < 0]
    print(f"{f['name']:<48} legal={f['legal']} min_margin={f['min_margin']:.2f} late={late}")
