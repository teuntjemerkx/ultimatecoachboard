import json, atlas  # re-runs atlas generation deterministically
a = json.load(open("atlas.json"))
import os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "CoachBoardCore", "Sources", "CoachBoardCore", "Resources", "Templates") + os.sep
ROUTES = {"target": [6.0, 0.7], "left": [-0.3, 3.8], "right": [9.3, 3.8], "quick": [4.6, 3.0], "pipe": [4.5, 6.6], "dball": [7.8, 6.6]}
def players(form):
    return [dict(role=p["role"], position=int(p["pos"][1]), anchor=[p["l"], p["d"]], passes=p["passer"],
                 route=(p["route"]["dest"] if p.get("route") else None)) for p in form["players"]]
rotnum = {"R1": 1, "R6": 6, "R5": 5, "R4": 4, "R3": 3, "R2": 2}
f51 = []
for f in a["f51"]:
    f51.append(dict(rotation=rotnum[f["name"].split()[1]], phase="receive", players=players(f), expectedMinMargin=f["min_margin"]))
for s in a["serve"]:
    ps = [dict(role=p["role"].replace(" (serves)", ""), position=int(p["pos"][1]), anchor=[p["l"], p["d"]], passes=False,
               route=None, switchTo=list(p["switch_to"])) for p in s["players"]]
    f51.append(dict(rotation=rotnum[s["name"].split()[1]], phase="serve", players=ps, expectedMinMargin=s["min_margin"]))
t51 = {"format": "cb.rotation-template/1", "id": "5-1-outside-follows-setter", "system": "5-1",
       "lineupOrder": ["S", "OH1", "MB1", "OPP", "OH2", "MB2"], "libero": {"replaces": ["MB1", "MB2"], "whenServing": False},
       "setterTarget": [6.0, 0.7], "routeTargets": ROUTES, "baseSlots": a["base"], "formations": f51}
json.dump(t51, open(OUT + "5-1-outside-follows-setter.json", "w"), indent=1)
pat = {"4-2 pattern A (front setter in P4)": 4, "4-2 pattern B (front setter in P3)": 3, "4-2 pattern C (front setter in P2)": 2}
f42 = [dict(rotation=pat[f["name"]], phase="receive", frontSetterPosition=pat[f["name"]], players=players(f), expectedMinMargin=f["min_margin"]) for f in a["f42"]]
t42 = {"format": "cb.rotation-template/1", "id": "4-2", "system": "4-2", "lineupOrder": ["S1", "OH1", "MB1", "S2", "OH2", "MB2"],
       "libero": None, "setterTarget": [6.0, 0.7], "routeTargets": ROUTES, "formations": f42,
       "note": "Patterns are indexed by the front-row setter's position; the same anchors apply with S1/S2, OH1/OH2, MB1/MB2 swapped."}
json.dump(t42, open(OUT + "4-2.json", "w"), indent=1)
yw = a["youth"]
ty = {"format": "cb.rotation-template/1", "id": "youth-w", "system": "youth-W", "lineupOrder": ["A", "B", "C", "D", "E", "F"], "libero": None,
      "setterTarget": [4.5, 0.8], "routeTargets": ROUTES,
      "formations": [dict(rotation=0, phase="receive", players=players(yw), expectedMinMargin=yw["min_margin"],
                          note="Position-based: the W is the same in every rotation; the player in P3 sets.")]}
json.dump(ty, open(OUT + "youth-w.json", "w"), indent=1)
prof = {"format": "cb.rule-court-profile/1", "name": "FIVB senior indoor",
        "source": "FIVB Official Volleyball Rules; verify against the current edition before each app release",
        "court": {"length": 18.0, "width": 9.0, "attackLine": 3.0, "lineWidth": 0.05, "freeZoneMin": 3.0},
        "net": {"heightPresets": {"men": 2.43, "women": 2.24}, "height": 2.43, "antennaAboveTape": 0.80, "tapeWidth": 0.07},
        "playersPerSide": 6, "rotation": {"enabled": True},
        "overlap": {"checkServingTeam": True, "checkReceivingTeam": True, "requireInsideCourt": True, "serverExempt": True,
                    "footprint": {"footLength": 0.28, "footWidth": 0.10, "stanceWidth": 0.30}},
        "libero": {"allowed": True, "maxPerTeam": 2, "mayServe": False},
        "substitutions": {"maxPerSet": 6},
        "scoring": {"pointsPerSet": 25, "decidingSetPoints": 15, "winBy": 2, "setsToWin": 3},
        "timeOuts": {"perSet": 2, "seconds": 30}}
json.dump(prof, open(os.path.join(OUT, "..", "Profiles", "fivb-senior.json"), "w"), indent=1)
print("ok", len(f51), len(f42))
