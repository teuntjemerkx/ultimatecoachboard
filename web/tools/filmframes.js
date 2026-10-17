// Dev helper (not part of the app): records the Video to 3D watch screen's 3D view as numbered JPEG frames, one by
// one at exact rally times, so it works while the page is not on screen (no frame clock needed). In the dev page,
// on the watch screen in Court or eye view:
//   const f = await import("/tools/filmframes.js"); await f.film("court", 10, 30);
// Each frame goes to the dev server's /__save (only the local clip server has it), e.g. court-0000.jpg.
const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;

export async function film(prefix, seconds = 10, fps = 30) {
  const canvas = document.querySelector("canvas");
  const board = canvas?.board;
  if (!board) return "no 3D board on screen";
  const range = document.querySelector("input[type=range]");
  const n = Math.round(seconds * fps);
  for (let k = 0; k <= n; k++) {
    valueSetter.call(range, String(k / fps));
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
    board.renderNow();
    // Read the picture straight after drawing it (the canvas keeps it until the next draw).
    const blob = await (await fetch(canvas.toDataURL("image/jpeg", 0.9))).blob();
    const res = await fetch(`/__save?name=${prefix}-${String(k).padStart(4, "0")}.jpg`, { method: "POST", body: blob });
    if (!res.ok) return `frame ${k}: ${res.status}`;
  }
  return `${n + 1} frames`;
}
