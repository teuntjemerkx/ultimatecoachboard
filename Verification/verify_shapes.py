import numpy as np, itertools, shapes as S
kinds = ["circle", "ellipse", "rect", "polygon", "freeform", "line"]
def run(seed, n, lam, tau):
    rng = np.random.default_rng(seed); conf = {k: {} for k in kinds}
    for k in kinds:
        for _ in range(n):
            got, _ = S.recognize(S.handdrawn(k, rng), lam=lam, tau=tau)
            got = {"open-freeform": "freeform"}.get(got, got)
            conf[k][got] = conf[k].get(got, 0) + 1
    acc = sum(conf[k].get(k, 0) for k in kinds) / (n * len(kinds))
    return acc, conf
best = None
for lam, tau in itertools.product([0.002, 0.004, 0.006, 0.01], [0.04, 0.06, 0.08]):
    acc, _ = run(1, 60, lam, tau)
    print(f"train lam={lam} tau={tau} acc={acc*100:.1f}%")
    if best is None or acc > best[0]: best = (acc, lam, tau)
acc, conf = run(99, 250, best[1], best[2])
print(f"\nTEST (seed 99, 250 strokes per class) with lam={best[1]} tau={best[2]}: accuracy={acc*100:.1f}%")
for k in kinds: print(f"  {k:9s} -> {dict(sorted(conf[k].items(), key=lambda x: -x[1]))}")
acc2, conf2 = run(99, 250, 0.004, 0.08)
print(f"\nTEST with blueprint defaults lam=0.004 tau=0.08: accuracy={acc2*100:.1f}%")
for k in kinds: print(f"  {k:9s} -> {dict(sorted(conf2[k].items(), key=lambda x: -x[1]))}")
