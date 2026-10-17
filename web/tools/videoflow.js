// Dev helper for Video to 3D in a desktop browser (not part of the app). In the dev server's page:
//   const g = await import("/tools/gif2video.js");
//   const clip = await g.gifToVideo("/tools/frames/rf_backview.gif");   // the CI's real rally, see HANDOFF.md
//   await (await caches.open("video-test")).put("/__test/rally.mp4", new Response(clip));
//   const f = await import("/tools/videoflow.js");
//   await f.importClip(); await f.markCorners(); await f.build();
// `importClip` deletes earlier videos first; `markCorners` drags the dots to the corners measured on that frame
// (RealCalibrationTests). After a build in dev, `compare` runs tracker variants on the same observations.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function importClip() {
  [...document.querySelectorAll("button.tab")].find((b) => b.textContent.includes("Video")).click();
  await wait(700);
  while (document.querySelector(".video-saved-item")) {
    const d = () => document.querySelector('.video-saved-item button[aria-label^="Delete"], .video-saved-item button[aria-label^="Tap again"]');
    d().click();
    await wait(200);
    d().click();
    await wait(400);
  }
  const blob = await (await (await caches.open("video-test")).match("/__test/rally.mp4")).blob();
  const input = document.querySelector("input[type=file]");
  const dt = new DataTransfer();
  dt.items.add(new File([blob], "rally.mp4", { type: "video/mp4" }));
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(2500);
}

export async function markCorners(targets = [[142, 136.5], [463.5, 136.5], [554.2, 331], [51.5, 331]], size = [600, 338]) {
  const box = document.querySelector(".video-still-box");
  const r = document.querySelector(".video-still").getBoundingClientRect();
  const opts = (x, y) => ({ bubbles: true, pointerId: 7, clientX: x, clientY: y, isPrimary: true, pointerType: "touch" });
  for (let k = 0; k < 4; k++) {
    const dot = document.querySelectorAll(".video-dot")[k];
    const b = dot.getBoundingClientRect();
    const sx = b.left + b.width / 2, sy = b.top + b.height / 2;
    dot.dispatchEvent(new PointerEvent("pointerdown", opts(sx, sy)));
    const tx = r.left + (targets[k][0] / size[0]) * r.width, ty = r.top + (targets[k][1] / size[1]) * r.height;
    for (let i = 1; i <= 4; i++) {
      box.dispatchEvent(new PointerEvent("pointermove", opts(sx + ((tx - sx) * i) / 4, sy + ((ty - sy) * i) / 4)));
      await wait(20);
    }
    box.dispatchEvent(new PointerEvent("pointerup", opts(tx, ty)));
    await wait(40);
  }
  await wait(200);
  return document.querySelector(".video-badge")?.textContent;
}

export async function build() {
  document.querySelector(".video-mark-foot .btn.primary").click();
  const t0 = performance.now();
  await wait(1500);
  while (document.querySelector(".video-stage-name")) await wait(1000);
  return { seconds: Math.round((performance.now() - t0) / 1000), title: document.querySelector(".bar h1")?.textContent };
}
export async function compare(variants) {
  const v = await import("/src/core/video/index.ts");
  const { RallyTracker } = await import("/src/app/video/rallyTracker.ts");
  const { observations, camera } = globalThis.__videoDebug;
  const cam = v.VideoCamera.decode(camera);
  const out = {};
  for (const [name, settings] of Object.entries(variants)) {
    const t0 = performance.now();
    const tracks = new RallyTracker(settings).track(observations, cam);
    const rows = tracks.map((t) => {
      const seen = t.samples.filter((s) => s.measured);
      const wrong = seen.filter((s) => (t.side === "home" ? s.measured.z < -0.7 : s.measured.z > 0.7)).length;
      const zs = seen.map((s) => s.measured.z);
      return `${t.side[0]} n${seen.length} wrong${wrong} z${Math.min(...zs).toFixed(1)}..${Math.max(...zs).toFixed(1)}`;
    });
    out[name] = { ms: Math.round(performance.now() - t0), rows };
  }
  return out;
}
