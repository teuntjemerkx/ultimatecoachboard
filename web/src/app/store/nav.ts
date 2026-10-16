import { create } from "zustand";

/** Where the coach is in the app. Screens take their own ids as parameters. */
export type Route =
  | { name: "home" }
  | { name: "settings" }
  | { name: "players" }
  | { name: "setup" }
  | { name: "live"; matchId: string }
  | { name: "log"; matchId: string }
  | { name: "season" }
  | { name: "studio"; boardId?: string }
  | { name: "video" }
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
