import { registerSW } from "virtual:pwa-register";
import { create } from "zustand";

/** A new version of the app has downloaded and waits; `apply` restarts into it. */
export const useUpdate = create<{ ready: boolean; apply: () => void }>(() => ({ ready: false, apply: () => location.reload() }));

/**
 * The installed app updates when the coach says so (a pill on the start screen), never in the middle of a match, and
 * looks for a new version each time it comes back to the front.
 */
export function startUpdates() {
  const update = registerSW({
    onNeedRefresh: () => useUpdate.setState({ ready: true }),
    onRegisteredSW: (_url, reg) => {
      if (!reg) return;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    },
  });
  useUpdate.setState({ apply: () => void update(true) });
  // A screen's code from an older version is gone after an update: start the new version instead of failing (once).
  window.addEventListener("vite:preloadError", (e) => {
    try {
      if (sessionStorage.getItem("coachboard.reloaded")) return;
      sessionStorage.setItem("coachboard.reloaded", "1");
    } catch { /* private browsing */ }
    e.preventDefault();
    location.reload();
  });
}
