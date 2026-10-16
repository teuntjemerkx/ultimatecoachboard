"""Builds CoachBoardCore/Sources/CoachBoardCore/Resources/Postures/library.json from the per-position research
files in Verification/postures/*.json (format: Verification/postures/SCHEMA.md).

Every posture is validated: known angle keys only, anatomical ranges, sane root values. Problems are printed and
the offending value is clamped (or the key dropped), so the app never receives an impossible joint angle.

Usage: python3 build_postures.py
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "postures")
OUT = os.path.join(HERE, "..", "CoachBoardCore", "Sources", "CoachBoardCore", "Resources", "Postures", "library.json")

RANGES = {
    "lumbar_flex": (-40, 70), "thoracic_flex": (-40, 50), "trunk_lateral": (-45, 45), "trunk_twist": (-70, 70),
    "neck_flex": (-60, 50),
    "shoulder_flex": (-60, 185), "shoulder_abd": (-30, 185), "shoulder_ext_rot": (-90, 170),
    "elbow_flex": (0, 150), "wrist_ext": (-80, 80),
    "hip_flex": (-30, 130), "hip_abd": (-25, 60), "hip_ext_rot": (-45, 60),
    "knee_flex": (0, 145), "ankle_dorsi": (-60, 45),
}
SIDED = {"shoulder_flex", "shoulder_abd", "shoulder_ext_rot", "elbow_flex", "wrist_ext",
         "hip_flex", "hip_abd", "hip_ext_rot", "knee_flex", "ankle_dorsi"}
POSITIONS = ["setter", "outside_hitter", "opposite", "middle_blocker", "libero"]

def allowed_keys():
    keys = {"lumbar_flex", "thoracic_flex", "trunk_lateral", "trunk_twist", "neck_flex"}
    for k in SIDED:
        keys.add("l_" + k); keys.add("r_" + k)
    return keys

def range_for(key):
    base = key[2:] if key[:2] in ("l_", "r_") else key
    return RANGES.get(base)

def clean(spec, position, problems):
    out = {"id": spec["id"], "name": spec.get("name", spec["id"])}
    for k in ("phase", "description", "confidence"):
        if isinstance(spec.get(k), str):
            out[k] = spec[k]
    ev = spec.get("evidence")
    if isinstance(ev, list):
        out["evidence"] = [str(e) for e in ev][:12]
    root = spec.get("root") or {}
    r = {}
    for k, lo, hi in (("jump_m", 0, 1.3), ("stance_width_m", 0, 1.6), ("stagger_m", -1.2, 1.2), ("yaw_deg", -180, 180)):
        v = root.get(k)
        if isinstance(v, (int, float)):
            if not lo <= v <= hi:
                problems.append(f"{position}/{spec['id']}: root {k}={v} outside {lo}..{hi}, clamped")
                v = max(lo, min(hi, v))
            r[k] = float(v)
    out["root"] = r
    angles = {}
    keys = allowed_keys()
    for k, v in (spec.get("angles") or {}).items():
        if k not in keys:
            problems.append(f"{position}/{spec['id']}: unknown angle key {k} dropped")
            continue
        if not isinstance(v, (int, float)):
            problems.append(f"{position}/{spec['id']}: {k} is not a number, dropped")
            continue
        lo, hi = range_for(k)
        if not lo <= v <= hi:
            problems.append(f"{position}/{spec['id']}: {k}={v} outside {lo}..{hi}, clamped")
            v = max(lo, min(hi, v))
        angles[k] = float(v)
    out["angles"] = angles
    return out

def main():
    problems = []
    positions = {}
    counts = {}
    for pos in POSITIONS:
        path = os.path.join(SRC, pos + ".json")
        if not os.path.exists(path):
            print("missing", path)
            continue
        data = json.load(open(path))
        techniques = []
        seen = set()
        for spec in data.get("techniques", []):
            if not isinstance(spec, dict) or "id" not in spec:
                continue
            if spec["id"] in seen:
                problems.append(f"{pos}: duplicate {spec['id']} (first kept)")
                continue
            seen.add(spec["id"])
            techniques.append(clean(spec, pos, problems))
        traits = {}
        for k in ("stature_m", "standing_reach_m", "spike_reach_m", "block_reach_m"):
            v = (data.get("traits") or {}).get(k)
            if isinstance(v, dict):
                traits[k] = {kk: float(vv) for kk, vv in v.items() if isinstance(vv, (int, float))}
        notes = (data.get("traits") or {}).get("build_notes")
        if isinstance(notes, str):
            traits["build_notes"] = notes
        positions[pos] = {"traits": traits, "techniques": techniques}
        counts[pos] = (len(techniques), len(data.get("sources", [])))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump({"version": 1, "positions": positions}, open(OUT, "w"), indent=1, sort_keys=True)
    for pos, (n, src) in counts.items():
        print(f"{pos}: {n} techniques, {src} sources")
    for p in problems:
        print("  !", p)
    print("wrote", os.path.relpath(OUT, HERE))

if __name__ == "__main__":
    main()
