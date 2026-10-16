// Dev helper (not part of the app): an animated GIF as a video file, recorded in real time from a canvas, so the
// Video to 3D import can be tried in a desktop browser with the CI's real broadcast rally.
export async function gifToVideo(url) {
  const data = await (await fetch(url)).arrayBuffer();
  const dec = new ImageDecoder({ data, type: "image/gif" });
  await dec.tracks.ready;
  const n = dec.tracks.selectedTrack.frameCount;
  const first = (await dec.decode({ frameIndex: 0 })).image;
  const w = first.displayWidth, h = first.displayHeight;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  g.drawImage(first, 0, 0);
  first.close();
  const type = ["video/mp4;codecs=avc1.42E01E", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
    .find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(c.captureStream(30), { mimeType: type, videoBitsPerSecond: 6e6 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start(500);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const { image } = await dec.decode({ frameIndex: i });
    const due = t0 + image.timestamp / 1000;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    g.drawImage(image, 0, 0);
    image.close();
  }
  await new Promise((r) => setTimeout(r, 150));
  rec.stop();
  await stopped;
  const base = type.split(";")[0];
  return new File([new Blob(chunks, { type: base })], `rally.${base.endsWith("mp4") ? "mp4" : "webm"}`, { type: base });
}
