import json
a = json.load(open("atlas.json"))
RN = {"target": "setter target", "left": "left approach", "right": "right approach", "quick": "quick approach",
      "pipe": "pipe approach", "dball": "D approach"}
def f(x): return f"{x:.1f}".replace("-", "−")
def table(form, show_route=True):
    lines = ["| Pos | Player | Anchor (ℓ, d) m | Passes | Goes to | Path m | Arrives s | Deadline s | Slack s |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    order = {"P4": 0, "P3": 1, "P2": 2, "P5": 3, "P6": 4, "P1": 5}
    for p in sorted(form["players"], key=lambda r: order[r["pos"]]):
        r = p.get("route")
        if r:
            dst = a["timing"]["dest"][r["dest"]]
            cols = [f"{RN[r['dest']]} ({f(dst[0])}, {f(dst[1])})", f"{r['length']:.2f}", f"{r['arrive']:.2f}", f"{r['deadline']:.2f}",
                    ("**" if r["slack"] < 0 else "") + f"{r['slack']:+.2f}".replace("-", "−") + (" LATE**" if r["slack"] < 0 else "")]
        else:
            cols = ["cover / base", "—", "—", "—", "—"]
        lines.append(f"| {p['pos']} | {p['role']} | ({f(p['l'])}, {f(p['d'])}) | {'yes' if p['passer'] else 'no'} | " + " | ".join(cols) + " |")
    return "\n".join(lines)
def margins(form):
    lab = {"fb": "ahead of", "left": "left of", "right": "right of"}
    return "Margins: " + " · ".join(f"{c['a']} {lab[c['kind']]} {c['b']} {c['margin']:.2f}" for c in form["constraints"]) + \
           f" — smallest {form['min_margin']:.2f} m, legal."
out = {}
s = []
for fm in a["f51"]:
    s.append(f"#### {fm['name'].replace('5-1 ', '')}\n\n{table(fm)}\n\n{margins(fm)}")
out["a2_tables"] = "\n\n".join(s)
bad = a["r1_bad"]
out["a2_bad"] = table(bad)
# serve
sv = ["| Rotation | Server | P4 | P3 | P2 | P5 | P6 | Longest switch | Smallest margin |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
for s_ in a["serve"]:
    by = {p["pos"]: p for p in s_["players"]}
    cell = lambda q: f"{by[q]['role']} ({f(by[q]['l'])}, {f(by[q]['d'])})"
    longest = max(s_["players"], key=lambda p: p["switch_len"])
    sv.append(f"| {s_['name'].split()[1]} | {by['P1']['role'].replace(' (serves)', '')} from ({f(by['P1']['l'])}, 10.0) | {cell('P4')} | {cell('P3')} | {cell('P2')} | {cell('P5')} | {cell('P6')} | "
              f"{longest['role'].replace(' (serves)', '')} {longest['switch_len']:.1f} m | {s_['min_margin']:.2f} m |")
out["a3_serve"] = "\n".join(sv)
s = []
for fm in a["f42"]:
    s.append(f"#### {fm['name']}\n\n{table(fm)}\n\n{margins(fm)}")
out["a4_42"] = "\n\n".join(s)
out["a5_w"] = table(a["youth"]) + "\n\n" + margins(a["youth"])
json.dump(out, open("atlas_md.json", "w"), indent=1)
for k, v in out.items(): print(f"===== {k}\n{v}\n")
