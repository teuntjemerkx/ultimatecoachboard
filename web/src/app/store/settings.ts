import { create } from "zustand";

/** Coach settings, kept in the browser (they survive restarts of the home-screen app). */
export interface Settings {
  themeId: string;
  /** Simple (default) shows the essentials in plain words; Advanced adds the expert tools. */
  advanced: boolean;
  /** Women: net 2.24 m and women's player heights; men: 2.43 m. */
  women: boolean;
  teamName: string;
}

const KEY = "coachboard.settings";
const defaults: Settings = { themeId: "prizm", advanced: false, women: true, teamName: "" };

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    const stored = raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
    // Once, with the Prizm look: the earlier defaults (Locker room, Game day) move to Prizm; a look picked since stays.
    if (localStorage.getItem("coachboard.prizm") === null) {
      localStorage.setItem("coachboard.prizm", "1");
      if (stored.themeId === "locker" || stored.themeId === "gameday") {
        const moved = { ...stored, themeId: "prizm" };
        localStorage.setItem(KEY, JSON.stringify(moved));
        return moved;
      }
    }
    return stored;
  } catch {
    return defaults;
  }
}

interface SettingsStore extends Settings {
  set(change: Partial<Settings>): void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...load(),
  set(change) {
    set(change);
    const { set: _ignored, ...plain } = { ...get(), ...change };
    try {
      localStorage.setItem(KEY, JSON.stringify(plain));
    } catch {
      /* private mode: settings last for this session */
    }
  },
}));

export const netHeight = (women: boolean) => (women ? 2.24 : 2.43);
