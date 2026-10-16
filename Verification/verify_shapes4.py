import numpy as np, itertools, shapes as S
from verify_shapes3 import run, kinds
import verify_shapes3
for label, wob in (("normal hand", (0.003, 0.012)), ("shaky hand", (0.005, 0.02))):
    best = None
    for tau, pr, cr in itertools.product([0.03, 0.035, 0.045], [0.008, 0.012, 0.02], [1.25, 1.3, 1.4]):
        acc, *_ = run(1, 40, S.recognize4, wobble=wob, tau=tau, prior=pr, circle_ratio=cr)
        if best is None or acc > best[0]: best = (acc, tau, pr, cr)
    acc, conf, altrate, rescued = run(99, 250, S.recognize4, wobble=wob, tau=best[1], prior=best[2], circle_ratio=best[3])
    print(f"== {label}: v4 (tau={best[1]}, prior={best[2]}, circle_ratio={best[3]}) TEST accuracy {acc*100:.1f}%, "
          f"alternative chip on {altrate*100:.1f}% of strokes, chip holds the intended shape for {rescued*100:.0f}% of misses")
    for kk in kinds: print(f"   {kk:9s} -> {dict(sorted(conf[kk].items(), key=lambda x: -x[1]))}")
