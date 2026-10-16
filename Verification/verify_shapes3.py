import numpy as np, itertools, shapes as S
kinds = ["circle", "ellipse", "rect", "polygon", "freeform", "line"]
def run(seed, n, rec, wobble=(0.003, 0.012), **kw):
    rng = np.random.default_rng(seed); conf = {k: {} for k in kinds}; alts = 0; wrong_with_alt = 0; wrong = 0
    for k in kinds:
        for _ in range(n):
            out = rec(S.handdrawn_v3(k, rng, wobble), **kw)
            got = {"open-freeform": "freeform"}.get(out[0], out[0]); alt = out[2] if len(out) > 2 else None
            conf[k][got] = conf[k].get(got, 0) + 1
            if alt: alts += 1
            if got != k:
                wrong += 1
                if alt == k: wrong_with_alt += 1
    acc = sum(conf[k].get(k, 0) for k in kinds) / (n * len(kinds))
    return acc, conf, alts / (n * len(kinds)), (wrong_with_alt / wrong if wrong else 1.0)
if __name__ == "__main__":
      for label, wob in (("normal hand (wobble 0.3-1.2% per harmonic)", (0.003, 0.012)), ("shaky hand (wobble 0.5-2% per harmonic)", (0.005, 0.02))):
        acc0, conf0, *_ = run(99, 250, lambda s, **k: S.recognize(s, lam=0.004, tau=0.08) + (None,), wobble=wob)
        best = None
        for tr, tp, cr in itertools.product([0.025, 0.035, 0.045], [0.03, 0.04, 0.05], [1.15, 1.25]):
            acc, *_ = run(1, 40, S.recognize3, wobble=wob, tau_round=tr, tau_poly=tp, circ_ratio=cr)
            if best is None or acc > best[0]: best = (acc, tr, tp, cr)
        acc, conf, altrate, rescued = run(99, 250, S.recognize3, wobble=wob, tau_round=best[1], tau_poly=best[2], circ_ratio=best[3])
        print(f"== {label}\n original method: {acc0*100:.1f}%   revised (tau_round={best[1]}, tau_poly={best[2]}, circ_ratio={best[3]}): {acc*100:.1f}%"
              f"   alternative chip shown on {altrate*100:.1f}% of strokes, and it holds the intended shape for {rescued*100:.0f}% of misses")
        for k in kinds: print(f"   {k:9s} -> {dict(sorted(conf[k].items(), key=lambda x: -x[1]))}")
