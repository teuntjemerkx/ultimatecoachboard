import { useEffect, useState } from "react";

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
