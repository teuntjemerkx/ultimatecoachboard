import { Icon } from "./Icon";
import { useNav, type Route } from "../store/nav";

/** The app's sections, one tap each. A screen inside a section (a new match, a match log) lights its section. */
const sections: { route: Route; label: string; icon: string; owns: Route["name"][] }[] = [
  { route: { name: "home" }, label: "Match", icon: "whistle", owns: ["home", "setup"] },
  { route: { name: "players" }, label: "Team", icon: "shirt", owns: ["players"] },
  { route: { name: "studio" }, label: "Studio", icon: "cube", owns: ["studio"] },
  { route: { name: "video" }, label: "Video", icon: "video", owns: ["video", "watch"] },
  { route: { name: "season" }, label: "Season", icon: "trophy", owns: ["season", "log"] },
];

/**
 * The tab bar: a capsule of glass with the five sections, and Settings beside it. `compact` shows the icons only (the
 * Studio, where the board needs the room; a narrow screen does the same by itself).
 */
export function Tabs({ compact = false }: { compact?: boolean }) {
  const route = useNav((s) => s.route);
  const go = useNav((s) => s.go);
  return (
    <nav className={`tabs${compact ? " compact" : ""}`} aria-label="Sections">
      <div className="tabs-track">
        {sections.map((s) => {
          const on = s.owns.includes(route.name);
          return (
            <button key={s.label} type="button" className="tab" aria-current={on ? "page" : undefined} aria-label={s.label}
                    onClick={() => { if (route.name !== s.route.name) go(s.route); }}>
              <Icon name={s.icon} /><span>{s.label}</span>
            </button>
          );
        })}
      </div>
      <button type="button" className="tab tab-round" aria-label="Settings" aria-current={route.name === "settings" ? "page" : undefined}
              onClick={() => { if (route.name !== "settings") go({ name: "settings" }); }}>
        <Icon name="settings" />
      </button>
    </nav>
  );
}
