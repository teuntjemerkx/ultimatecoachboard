import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { VideoMarker, VideoScene } from "../../core/video";
import { useNav } from "../store/nav";
import { useSettings } from "../store/settings";
import { Icon } from "../ui/Icon";
import { loadVideo, type StoredVideo } from "./videoStore";
import { WatchBoard, type WatchView } from "./WatchBoard";
import "./video.css";

interface Loaded {
  stored: StoredVideo;
  scene: VideoScene;
  clipURL?: string;
  plateURL?: string;
}

/**
 * Watching a rebuilt video (Section 4.6): the clip plays with a ring on every player; tapping one flies into that
 * player's eyes, and the eye view keeps running with the clip (shown small in the corner). "Court" shows the 3D court
 * in the hall from the video instead.
 */
export function VideoWatch({ videoId }: { videoId: string }) {
  const go = useNav((s) => s.go);
  const [data, setData] = useState<Loaded | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    void loadVideo(videoId).then((r) => {
      if (!alive) return;
      if (!r) { setData(null); return; }
      const clipURL = r.stored.clip ? URL.createObjectURL(r.stored.clip) : undefined;
      const plateURL = r.stored.plate ? URL.createObjectURL(r.stored.plate) : undefined;
      for (const u of [clipURL, plateURL]) if (u) urls.push(u);
      setData({ stored: r.stored, scene: r.scene, clipURL, plateURL });
    }).catch(() => { if (alive) setData(null); });
    return () => {
      alive = false;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [videoId]);

  if (!data) {
    return (
      <div className="screen">
        <header className="bar">
          <button className="btn quiet" onClick={() => go({ name: "video" })} aria-label="Videos"><Icon name="back" /> Videos</button>
          <h1>Video</h1>
        </header>
        <div className="empty">{data === null ? "This video is not on this iPad any more." : "Opening the video…"}</div>
      </div>
    );
  }
  return <Watch data={data} />;
}

function Watch({ data }: { data: Loaded }) {
  const { scene, clipURL, plateURL } = data;
  const go = useNav((s) => s.go);
  const themeId = useSettings((s) => s.themeId);
  const duration = Math.max(scene.duration, 0.1);
  const clipStart = scene.clipStart ?? 0;
  const [mode, setMode] = useState<"video" | "court">("video");
  const [pov, setPov] = useState<string | undefined>();
  const [look, setLook] = useState({ yaw: 0, pitch: 0 });
  const [selected, setSelected] = useState<string | undefined>();
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [slow, setSlow] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const view = useRef<WatchView>({ time: 0, povYaw: 0, povPitch: 0 });
  const clock = useRef({ playing: false, from: 0, at: 0, rate: 1 });
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });

  view.current = { ...view.current, pov, povYaw: look.yaw, povPitch: look.pitch, selected: pov ? undefined : selected };

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // The clock: the clip when there is one, else a clock of our own (a backup without the clips).
  useEffect(() => {
    let raf = 0;
    let shown = -1;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const v = videoRef.current, c = clock.current;
      let t = view.current.time;
      if (v && clipURL) {
        if (!v.seeking) t = v.currentTime - clipStart;
      } else if (c.playing) {
        t = c.from + ((now - c.at) / 1000) * c.rate;
      }
      t = Math.max(0, Math.min(duration, t));
      if (c.playing && t >= duration - 1e-3) {
        c.playing = false;
        v?.pause();
        setPlaying(false);
      }
      view.current.time = t;
      if (Math.abs(t - shown) > 1 / 240) {
        shown = t;
        setTime(t);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [clipURL, clipStart, duration]);

  // The clip starts at the rally's first frame.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const ready = () => { v.currentTime = clipStart; };
    if (v.readyState >= 1) ready();
    else v.addEventListener("loadedmetadata", ready, { once: true });
    return () => v.removeEventListener("loadedmetadata", ready);
  }, [clipURL, clipStart]);

  const seek = useCallback((t: number) => {
    const tt = Math.max(0, Math.min(duration, t));
    view.current.time = tt;
    setTime(tt);
    const v = videoRef.current;
    if (v && clipURL) v.currentTime = clipStart + tt;
    clock.current.from = tt;
    clock.current.at = performance.now();
  }, [clipURL, clipStart, duration]);

  const pause = useCallback(() => {
    clock.current.playing = false;
    videoRef.current?.pause();
    setPlaying(false);
  }, []);

  const play = useCallback(() => {
    if (view.current.time >= duration - 1e-3) seek(0);
    const rate = slow ? 0.5 : 1;
    clock.current = { playing: true, from: view.current.time, at: performance.now(), rate };
    const v = videoRef.current;
    if (v && clipURL) {
      v.playbackRate = rate;
      void v.play().catch(() => pause());
    }
    setPlaying(true);
  }, [clipURL, duration, pause, seek, slow]);

  const toggleSlow = () => {
    const next = !slow;
    setSlow(next);
    const v = videoRef.current;
    if (v) v.playbackRate = next ? 0.5 : 1;
    if (clock.current.playing) clock.current = { playing: true, from: view.current.time, at: performance.now(), rate: next ? 0.5 : 1 };
  };

  // Into a player's eyes at the current moment.
  const watch = (id: string) => {
    setLook({ yaw: 0, pitch: 0 });
    setSelected(id);
    setPov(id);
  };
  const backToVideo = () => {
    setPov(undefined);
    setSelected(undefined);
    setMode("video");
  };
  const showCourt = () => {
    setPov(undefined);
    setMode("court");
  };

  const lim = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
  const onLook = useCallback((dYaw: number, dPitch: number) => {
    setLook((l) => ({ yaw: lim(l.yaw - dYaw, -1.22, 1.22), pitch: lim(l.pitch + dPitch, -0.87, 1.05) }));
  }, []);
  const onTap = useCallback((id: string | undefined) => {
    if (view.current.pov) {
      if (id && id !== view.current.pov) { setLook({ yaw: 0, pitch: 0 }); setSelected(id); setPov(id); }
      return;
    }
    setSelected(id);
  }, []);

  const threeD = mode === "court" || pov !== undefined;
  const aspect = scene.camera.width / Math.max(scene.camera.height, 1);
  const fit = (() => {
    const w = Math.min(stage.w, stage.h * aspect), h = w / aspect;
    return { x: (stage.w - w) / 2, y: (stage.h - h) / 2, w, h };
  })();
  const markers: VideoMarker[] = !threeD && stage.w > 0 ? scene.markers(time) : [];
  const label = (id: string | undefined) => scene.players.find((p) => p.id === id)?.label ?? "";
  const videoClass = pov ? "video-media corner" : threeD ? "video-media hidden" : "video-media";

  return (
    <div className="screen video-screen">
      <header className="bar video-bar">
        <button className="btn quiet" onClick={() => go({ name: "video" })} aria-label="Your videos"><Icon name="back" /> Videos</button>
        <h1>{scene.title}</h1>
        <div className="video-switch" role="group" aria-label="View">
          <button aria-pressed={!threeD} onClick={backToVideo}>VIDEO</button>
          <button aria-pressed={mode === "court" && !pov} onClick={showCourt}>COURT</button>
        </div>
      </header>
      <div className="video-stage" ref={stageRef}>
        {threeD && (
          <div className="video-board">
            <WatchBoard scene={scene} view={view} themeKey={themeId} onTap={onTap} onLook={onLook} />
          </div>
        )}
        <div className={videoClass} style={pov ? { aspectRatio: `${scene.camera.width} / ${scene.camera.height}` }
          : { left: fit.x, top: fit.y, width: fit.w, height: fit.h }}
             onClick={pov ? backToVideo : undefined} role={pov ? "button" : undefined} aria-label={pov ? "Back to the video" : undefined}>
          {clipURL
            ? <video ref={videoRef} src={clipURL} playsInline muted preload="auto" onEnded={pause} />
            : plateURL ? <img src={plateURL} alt="" /> : null}
        </div>
        {!threeD && markers.map((m) => <PlayerMarker key={m.id} marker={m} fit={fit} onTap={() => watch(m.id)} />)}
        {!threeD && <div className="hint-pill video-hint">Tap a player to see through their eyes</div>}
        <div className="video-dock">
          {pov && (
            <div className="panel video-emphasis">
              <span className="video-label">Eye view of {label(pov)}</span>
              <button className={`video-chip${look.yaw === 0 && look.pitch === 0 ? " on" : ""}`} onClick={() => setLook({ yaw: 0, pitch: 0 })}>Look ahead</button>
              <button className="video-chip prominent" onClick={backToVideo}><Icon name="video" /> Back to video</button>
            </div>
          )}
          {!pov && mode === "court" && selected && (
            <div className="panel video-emphasis">
              <button className="video-chip prominent" onClick={() => watch(selected)}><Icon name="eye" /> See what {label(selected)} sees</button>
            </div>
          )}
          <div className="panel video-strip">
            <button className="video-chip video-play prominent" onClick={playing ? pause : play} aria-label={playing ? "Pause" : "Play"}>
              <Icon name={playing ? "pause" : "play"} />
            </button>
            <input type="range" className="video-scrub" min={0} max={duration} step={0.01} value={time} aria-label="Time in the rally"
                   onChange={(e) => { if (playing) pause(); seek(Number(e.target.value)); }} />
            <span className="mono video-time">{time.toFixed(1)} / {duration.toFixed(1)} s</span>
            <button className={`video-chip${slow ? " on" : ""}`} onClick={toggleSlow} aria-pressed={slow}><Icon name="tortoise" /> Slow</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A ring at the player's feet and the number above the head; the whole body is the tap target. */
function PlayerMarker({ marker, fit, onTap }: { marker: VideoMarker; fit: { x: number; y: number; w: number; h: number }; onTap: () => void }) {
  const foot = { x: fit.x + marker.foot.x * fit.w, y: fit.y + marker.foot.y * fit.h };
  const head = { x: fit.x + marker.head.x * fit.w, y: fit.y + marker.head.y * fit.h };
  const tall = Math.max(foot.y - head.y, 30);
  const w = Math.max(tall * 0.6, 44), h = tall + 30;
  return (
    <button className={`video-marker ${marker.side}`} onClick={onTap} aria-label={`Player ${marker.label}: see through their eyes`}
            style={{ left: (foot.x + head.x) / 2 - w / 2, top: (foot.y + head.y) / 2 - 8 - h / 2, width: w, height: h }}>
      <span className="video-marker-label">{marker.label}</span>
      <span className="video-marker-ring" style={{ width: Math.max(tall * 0.55, 30), height: Math.max(tall * 0.16, 10) }} />
    </button>
  );
}
