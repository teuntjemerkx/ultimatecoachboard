import { create } from "zustand";

/** Where the coach is in the app. Screens take their own ids as parameters. */
export type Route =
  | { name: "home" }
  | { name: "settings"; /** The section to open (default: the first). */ section?: string }
  | { name: "players" }
  | { name: "setup"; /** A match from the linked schedule. */ scheduled?: string }
  | { name: "live"; matchId: string }
  | { name: "log"; matchId: string }
  | { name: "season" }
  | { name: "studio"; boardId?: string }
  | { name: "video"; /** A rebuilt video to put its players right in, at a moment of it. */ fix?: { videoId: string; time?: number } }
  | { name: "watch"; videoId: string };

interface Nav {
  route: Route;
  go(route: Route): void;
}

export const useNav = create<Nav>((set) => ({
  route: { name: "home" },
  go(route) {
    set({ route });
  },
}));
