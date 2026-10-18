// Dev helper for Video to 3D in a desktop browser (not part of the app). In the dev server's page:
//   const g = await import("/tools/gif2video.js");
//   const clip = await g.gifToVideo("/tools/frames/rf_backview.gif");   // the CI's real rally, see HANDOFF.md
//   await (await caches.open("video-test")).put("/__test/rally.mp4", new Response(clip));
//   const f = await import("/tools/videoflow.js");
//   await f.importClip(); await f.markCorners(); await f.build();
// `importClip` deletes earlier videos first; `markCorners` drags the dots to the corners measured on that frame
// (RealCalibrationTests). After a build in dev, `compare` runs tracker variants on the same observations, and `unseen`
// and `stillPeople` give the numbers in HANDOFF.md (unseen samples of the picked players, people on the still).
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

/** On to tapping the players (from the court step), and waits until the people on the still are found. */
export async function toPlayers() {
  if (document.querySelector(".video-dot")) document.querySelector(".video-mark-foot .btn.primary").click();
  await wait(300);
  while (document.querySelector(".video-finding")?.textContent.startsWith("Finding")) await wait(300);
  return document.querySelector(".video-mark-foot .video-badge")?.textContent;
}

/** On the players step: shows the moment `t` (seconds into the rally) and waits until its people are found. */
export async function moment(t) {
  const range = document.querySelector(".video-time input[type=range]");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(range, String(t));
  range.dispatchEvent(new Event("input", { bubbles: true }));
  range.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(400);
  while (document.querySelector(".video-finding")?.textContent.startsWith("Finding")) await wait(300);
  return [...document.querySelectorAll(".video-people rect")].map((r) => ({
    box: ["x", "y", "width", "height"].map((a) => Math.round(+r.getAttribute(a))), cls: r.getAttribute("class") }));
}

/** On the players step: a tap at a pixel of the frame (the clip's working size `w` x `h`). */
export async function tap(x, y, w = 1280, h = 720) {
  const box = document.querySelector(".video-still-box");
  const r = document.querySelector(".video-still").getBoundingClientRect();
  box.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 9, isPrimary: true,
    clientX: r.left + (x / w) * r.width, clientY: r.top + (y / h) * r.height }));
  await wait(200);
  return document.querySelector(".video-mark-foot .video-badge")?.textContent.trim();
}

/** On the players step: who the next taps are for, by chip label ("New" for a new player). */
export async function tapsFor(label) {
  const chip = [...document.querySelectorAll(".video-chip")].find((c) => c.textContent.trim().replace(/\d+$/, "") === label
    || c.textContent.trim().startsWith(label));
  if (chip && chip.getAttribute("aria-pressed") !== "true") chip.click();
  await wait(100);
  return [...document.querySelectorAll(".video-chip")].map((c) => `${c.textContent.trim()}${c.getAttribute("aria-pressed") === "true" ? "*" : ""}`);
}

/** Builds with the players picked (from the court step: those inside the lines). */
export async function build() {
  await toPlayers();
  document.querySelector(".video-mark-foot .btn.primary").click();
  const t0 = performance.now();
  await wait(1500);
  while (document.querySelector(".video-stage-name")) await wait(1000);
  return { seconds: Math.round((performance.now() - t0) / 1000), title: document.querySelector(".bar h1")?.textContent };
}
/**
 * After a build in dev: how much of the picked players' clip the detector saw (the share of their samples with no
 * detection, overall and per side) and the ball points, from the build's observations and locks.
 */
export async function unseen() {
  const v = await import("/src/core/video/index.ts");
  const { RallyTracker } = await import("/src/app/video/rallyTracker.ts");
  const { observations, camera, locks } = globalThis.__videoDebug;
  const cam = v.VideoCamera.decode(camera);
  const tracks = RallyTracker.forCamera(cam, locks ?? []).track(observations, cam);
  const share = (ts) => {
    const all = ts.flatMap((t) => t.samples);
    return all.length ? Math.round((100 * all.filter((s) => !s.measured).length) / all.length) : 0;
  };
  return {
    unseen: share(tracks), home: share(tracks.filter((t) => t.side === "home")), away: share(tracks.filter((t) => t.side !== "home")),
    players: tracks.length, ballPoints: observations.filter((o) => o.ball).length,
  };
}

/**
 * After a build in dev: the people the detector finds on the still (start + 0.2 s) of the clip in the "video-test"
 * cache, where they stand, and how many stand inside the lines on each side (with the players step's 15 cm).
 */
export async function stillPeople(time = 0.2) {
  const v = await import("/src/core/video/index.ts");
  const { openClip, grabFrame, SEEK_INTO_FRAME } = await import("/src/app/video/clip.ts");
  const { peopleOnStill } = await import("/src/app/video/pipeline.ts");
  const cam = v.VideoCamera.decode(globalThis.__videoDebug.camera);
  const blob = await (await (await caches.open("video-test")).match("/__test/rally.mp4")).blob();
  const clip = await openClip(blob);
  const still = document.createElement("canvas");
  await grabFrame(clip, time + SEEK_INTO_FRAME, still);
  clip.close();
  const t0 = performance.now();
  const people = await peopleOnStill(still, cam);
  const ms = Math.round(performance.now() - t0);
  const inside = (f) => Math.abs(f.x) <= 4.65 && Math.abs(f.z) <= 9.15;
  const rows = people.map((p) => ({ x: +p.detection.floor.x.toFixed(1), z: +p.detection.floor.z.toFixed(1),
    box: [p.box.x, p.box.y, p.box.w, p.box.h].map(Math.round) }));
  return { ms, ours: rows.filter((r) => inside(r) && r.z > 0).length, theirs: rows.filter((r) => inside(r) && r.z < 0).length, rows };
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
