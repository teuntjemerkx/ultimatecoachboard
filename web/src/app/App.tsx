import { useEffect } from "react";
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

export function App() {
  const route = useNav((s) => s.route);
  const themeId = useSettings((s) => s.themeId);
  useEffect(() => applyTheme(themeById(themeId)), [themeId]);

  return <div className="app">{screen(route)}</div>;
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
    default: return <div className="screen"><Bar title="Coming next" /><div className="empty">This part is being built.</div></div>;
  }
}
