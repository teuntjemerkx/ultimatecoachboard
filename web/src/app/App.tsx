import { useEffect } from "react";
import "./styles.css";
import { useNav } from "./store/nav";
import { useSettings } from "./store/settings";
import { applyTheme, themeById } from "./theme";
import { Home } from "./screens/Home";
import { Settings } from "./screens/Settings";
import { Players } from "./screens/Players";
import { Bar } from "./ui/Bar";

export function App() {
  const route = useNav((s) => s.route);
  const themeId = useSettings((s) => s.themeId);
  useEffect(() => applyTheme(themeById(themeId)), [themeId]);

  return <div className="app">{screen(route.name)}</div>;
}

function screen(name: string) {
  switch (name) {
    case "home": return <Home />;
    case "settings": return <Settings />;
    case "players": return <Players />;
    default: return <div className="screen"><Bar title="Coming next" /><div className="empty">This part is being built.</div></div>;
  }
}
