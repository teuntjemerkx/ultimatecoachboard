/**
 * A video file opened in a hidden <video> element for reading frames: seek, then draw. Safari on the iPad decodes a
 * frame only once the element has played, so opening starts and pauses it (muted, inline).
 */
export interface Clip {
  video: HTMLVideoElement;
  url: string;
  /** Seconds. */
  duration: number;
  /** The frame size frames are read at: the video's own size, at most 1920 pixels on the long side. */
  width: number;
  height: number;
  close(): void;
}

function once(target: EventTarget, event: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      target.removeEventListener(event, on);
      clearTimeout(timer);
      resolve(ok);
    };
    const on = () => done(true);
    const timer = setTimeout(() => done(false), timeout);
    target.addEventListener(event, on);
  });
}

export async function openClip(file: Blob, maxSide = 1920): Promise<Clip> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  // In the document (invisible): some browsers do not decode frames of a detached element.
  Object.assign(video.style, { position: "fixed", left: "-10px", top: "-10px", width: "2px", height: "2px", opacity: "0", pointerEvents: "none" });
  document.body.appendChild(video);
  const close = () => {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  };
  video.src = url;
  if (video.readyState < 1 && !(await once(video, "loadedmetadata", 20000))) {
    close();
    throw new Error("That video could not be opened.");
  }
  if (!video.videoWidth || !video.videoHeight) {
    close();
    throw new Error("This file has no picture.");
  }
  // Some recordings report no length until the end has been reached.
  let duration = video.duration;
  if (!Number.isFinite(duration)) {
    video.currentTime = 1e7;
    await once(video, "seeked", 8000);
    duration = video.duration;
    if (!Number.isFinite(duration)) duration = video.currentTime;
  }
  try {
    await video.play();
  } catch {
    /* not allowed or not needed: seeking still works on most browsers */
  }
  video.pause();
  const s = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  return { video, url, duration, width: Math.round(video.videoWidth * s), height: Math.round(video.videoHeight * s), close };
}

/**
 * How far past a time a read seeks, for the frame on screen at that time: in Chromium a seek to the exact start of a
 * frame often shows the frame before it (a 30 fps clip read at k/30 s showed it on every third read). Past any rounding
 * of the times (whole microseconds, or whole milliseconds in WebM), under half a frame at 60 fps.
 */
export const SEEK_INTO_FRAME = 0.005;

/** Seeks to a time and waits until the frame there can be drawn. */
export async function seekClip(clip: Clip, t: number): Promise<void> {
  const v = clip.video;
  const target = Math.max(0, Math.min(t, clip.duration - 0.01));
  if (Math.abs(v.currentTime - target) > 1e-3) {
    v.currentTime = target;
    await once(v, "seeked", 8000);
  }
  if (v.readyState < 2) await once(v, "loadeddata", 4000);
}

/** The current frame drawn into a canvas of the given size (default: the clip's working size). */
export function drawFrame(clip: Clip, canvas?: HTMLCanvasElement, width = clip.width, height = clip.height): HTMLCanvasElement {
  const c = canvas ?? document.createElement("canvas");
  if (c.width !== width) c.width = width;
  if (c.height !== height) c.height = height;
  c.getContext("2d", { willReadFrequently: true })!.drawImage(clip.video, 0, 0, width, height);
  return c;
}

/** Whether a drawn frame is all black (nothing decoded yet), from a sparse sample of its pixels. */
function blank(c: HTMLCanvasElement): boolean {
  const g = c.getContext("2d", { willReadFrequently: true })!;
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const step = Math.max(4, Math.floor(d.length / 4 / 997) * 4);
  for (let i = 0; i < d.length; i += step) if (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8) return false;
  return true;
}

/**
 * The frame at a time, drawn into a canvas of the clip's working size. Right after opening, a browser may report a
 * seek as done before it has decoded anything; an all-black frame is read again a few times before it is accepted.
 */
export async function grabFrame(clip: Clip, t: number, canvas?: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  await seekClip(clip, t);
  let c = drawFrame(clip, canvas);
  for (let k = 1; k <= 6 && blank(c); k++) {
    await new Promise((r) => setTimeout(r, 60 * k));
    c = drawFrame(clip, c);
  }
  return c;
}

