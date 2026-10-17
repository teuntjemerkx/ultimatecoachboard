import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { Tabs } from "./Tabs";
import { useNav, type Route } from "../store/nav";

/**
 * The top bar of every screen outside a match: the screen's name on the left (with a way back for a screen inside a
 * section), the tab bar in the middle, the screen's own actions on the right.
 */
export function Bar({ title, subtitle, children, back }: {
  title: string;
  /** A small line above the title (the date on the start screen). */
  subtitle?: ReactNode;
  children?: ReactNode;
  /** Where the back button goes, for a screen inside a section; none for a section itself. */
  back?: { to: Route; label: string };
}) {
  const go = useNav((s) => s.go);
  return (
    <header className="bar">
      <div className="bar-lead">
        {back && (
          <button className="btn back-btn" onClick={() => go(back.to)} aria-label={`Back to ${back.label}`}>
            <Icon name="back" /><span>{back.label}</span>
          </button>
        )}
        <div className="bar-titles">
          {subtitle && <div className="bar-subtitle">{subtitle}</div>}
          <h1>{title}</h1>
        </div>
      </div>
      <Tabs />
      <div className="bar-trail">{children}</div>
    </header>
  );
}
