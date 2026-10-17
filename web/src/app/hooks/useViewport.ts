import { useEffect, useState, type RefObject } from "react";

/** True when the screen is taller than wide (the court then stands upright). */
export function usePortrait(): boolean {
  const q = () => window.innerHeight > window.innerWidth * 1.1;
  const [portrait, setPortrait] = useState(q);
  useEffect(() => {
    const f = () => setPortrait(q());
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return portrait;
}

/**
 * How to lay out `count` cards (height = width * `aspect`) as large as possible inside the element without scrolling:
 * the number of columns and the card width in pixels (the gap between cards in pixels). Measured again on resize.
 * With `cols` the number of columns is fixed (a lineup in its court layout); `reserve` is height (px) other content in
 * the element takes.
 */
export function useFitColumns(el: RefObject<HTMLElement | null>, count: number, aspect = 1.4, gap = 14, cols?: number,
                              reserve = 0): { cols: number; width: number } {
  const [fit, setFit] = useState({ cols: 1, width: 0 });
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const measure = () => {
      const W = node.clientWidth, H = node.clientHeight - reserve;
      if (!(W > 0 && H > 0) || count === 0) return;
      let best = { cols: 1, width: 0 };
      for (let c = cols ?? 1; c <= (cols ?? count); c++) {
        const rows = Math.ceil(count / c);
        const w = Math.floor(Math.min((W - gap * (c - 1)) / c, (H - gap * (rows - 1)) / rows / aspect));
        if (w > best.width) best = { cols: c, width: w };
      }
      setFit((f) => (f.cols === best.cols && f.width === best.width ? f : best));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [el, count, aspect, gap, cols, reserve]);
  return fit;
}
