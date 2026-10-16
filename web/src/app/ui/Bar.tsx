import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { useNav } from "../store/nav";

/** The top bar: Home on the left, the title, then the screen's own actions. */
export function Bar({ title, children, back = true }: { title: string; children?: ReactNode; back?: boolean }) {
  const go = useNav((s) => s.go);
  return (
    <header className="bar">
      {back && (
        <button className="btn quiet" onClick={() => go({ name: "home" })} aria-label="Home">
          <Icon name="back" /> Home
        </button>
      )}
      <h1>{title}</h1>
      {children}
    </header>
  );
}
