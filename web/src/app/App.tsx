import { lazy, Suspense, useEffect } from "react";
import "./styles.css";
import { useNav } from "./store/nav";
import { useSettings } from "./store/settings";
import { applyTheme, themeById } from "./theme";
import { Home } from "./screens/Home";
import { Settings } from "./screens/Settings";
import { Players } from "./screens/Players";
import { Bar } from "./ui/Bar";
import { MatchSetup } from "./screens/MatchSetup";
import { Live } from "./screens/Live";
import { MatchLogView } from "./screens/MatchLogView";
import { Season } from "./screens/Season";
import type { Route } from "./store/nav";

// The 3D parts (three.js, the athletes, MediaPipe) load when first opened, so the app itself starts small.
const Studio = lazy(() => import("./studio/StudioScreen").then((m) => ({ default: m.Studio })));
const VideoImport = lazy(() => import("./video/VideoImport").then((m) => ({ default: m.VideoImport })));
const VideoWatch = lazy(() => import("./video/VideoWatch").then((m) => ({ default: m.VideoWatch })));

export function App() {
  const route = useNav((s) => s.route);
  const themeId = useSettings((s) => s.themeId);
  useEffect(() => applyTheme(themeById(themeId)), [themeId]);

  return (
    <div className="app">
      <Suspense fallback={<div className="screen"><div className="empty" style={{ flex: 1 }}>Loading…</div></div>}>{screen(route)}</Suspense>
    </div>
  );
}

function screen(route: Route) {
  switch (route.name) {
    case "home": return <Home />;
    case "settings": return <Settings />;
    case "players": return <Players />;
    case "setup": return <MatchSetup />;
    case "live": return <Live key={route.matchId} matchId={route.matchId} />;
    case "log": return <MatchLogView key={route.matchId} matchId={route.matchId} />;
    case "season": return <Season />;
    case "studio": return <Studio boardId={route.boardId} />;
    case "video": return <VideoImport key={route.fix?.videoId ?? "new"} fix={route.fix} />;
    case "watch": return <VideoWatch key={route.videoId} videoId={route.videoId} />;
    default: return <div className="screen"><Bar title="Coming next" /><div className="empty">This part is being built.</div></div>;
  }
}
