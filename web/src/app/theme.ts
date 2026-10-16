/** Visual templates (the iPad app's research-based templates): colours as CSS variables on the document root. */
export interface Theme {
  id: string;
  name: string;
  summary: string;
  dark: boolean;
  colors: Record<string, string>;
}

/** The default: an American locker room. White and navy, a blue LED accent, condensed athletic type for names and
 *  numbers; the court and the team colours stay those of the research (blue against orange). */
const locker: Theme = {
  id: "locker",
  name: "Locker room",
  summary: "White and navy with a blue light, athletic lettering. Home blue against orange stays.",
  dark: false,
  colors: {
    bg: "#EEF2F8", surface: "#FFFFFF", hairline: "rgba(10,37,84,0.14)", text: "#0A1A33", text2: "#46557A",
    accent: "#0A2A66", onAccent: "#FFFFFF", fault: "#C2410C", home: "#0067A5", opponent: "#D55E00",
    tokenFill: "#FFFFFF", tokenLabel: "#0A1A33", hallFloor: "#E8EDF5", freeZone: "#D6E1F0", court: "#F7F3EA",
    courtLine: "#0A1A33", net: "#0A1A33", ink: "#7C3AED", ball: "#F2B705", skin: "#C9A68A", shorts: "#0A2A66",
    pads: "#1E2C48", shoes: "#FFFFFF", hair: "#2B2118", focus: "#2D7DFF",
    band: "#0A2A66", bandText: "#FFFFFF", bandSoft: "#9DB8E8", led: "#2D7DFF", zoneA: "#0067A5", zoneB: "#D55E00",
  },
};

const hall: Theme = {
  id: "hall",
  name: "Sports hall",
  summary: "Light and high contrast for a lit hall. Blue against orange, readable with colour blindness.",
  dark: false,
  colors: {
    bg: "#F4F6F9", surface: "#FFFFFF", hairline: "rgba(17,24,39,0.12)", text: "#111827", text2: "#4B5563",
    accent: "#111827", onAccent: "#FFFFFF", fault: "#C2410C", home: "#0067A5", opponent: "#D55E00",
    tokenFill: "#FFFFFF", tokenLabel: "#111827", hallFloor: "#EEF1F5", freeZone: "#D9E2EC", court: "#F7F3EA",
    courtLine: "#1F2937", net: "#111827", ink: "#7C3AED", ball: "#F2B705", skin: "#C9A68A", shorts: "#1F2937",
    pads: "#374151", shoes: "#FFFFFF", hair: "#2B2118", focus: "#2563EB",
    band: "#111827", bandText: "#FFFFFF", bandSoft: "#9CA3AF", led: "#2563EB", zoneA: "#0067A5", zoneB: "#D55E00",
  },
};

const night: Theme = {
  id: "night",
  name: "Evening",
  summary: "Dark and calm for dim rooms and video review, the same colour-blind-safe pairing.",
  dark: true,
  colors: {
    bg: "#0E1116", surface: "#181C24", hairline: "rgba(255,255,255,0.10)", text: "#E8EAED", text2: "#9AA4B2",
    accent: "#E8EAED", onAccent: "#0E1116", fault: "#FF7A45", home: "#56B4E9", opponent: "#E69F00",
    tokenFill: "rgba(14,17,22,0.85)", tokenLabel: "#FFFFFF", hallFloor: "#0B0E13", freeZone: "#121822", court: "#1A2230",
    courtLine: "#C9D1DC", net: "#E8EAED", ink: "#C084FC", ball: "#FFE14D", skin: "#8D7A6E", shorts: "#1C2533",
    pads: "#2A3445", shoes: "#E8EAED", hair: "#15110E", focus: "#60A5FA",
    band: "#0B2A5C", bandText: "#FFFFFF", bandSoft: "#8FB4F0", led: "#4C9BFF", zoneA: "#56B4E9", zoneB: "#E69F00",
  },
};

const broadcast: Theme = {
  id: "broadcast",
  name: "TV broadcast",
  summary: "Terracotta court, blue free zone, white lines and a big scoreboard, like on TV.",
  dark: true,
  colors: {
    bg: "#0A1A33", surface: "#10284D", hairline: "rgba(255,255,255,0.14)", text: "#FFFFFF", text2: "#B8C4D9",
    accent: "#FFD23F", onAccent: "#0A1A33", fault: "#FF5A36", home: "#FFD23F", opponent: "#FFFFFF",
    tokenFill: "rgba(10,26,51,0.92)", tokenLabel: "#FFFFFF", hallFloor: "#081428", freeZone: "#1E5AA8", court: "#B8501F",
    courtLine: "#FFFFFF", net: "#FFFFFF", ink: "#FFD23F", ball: "#FFE14D", skin: "#B98A6A", shorts: "#0A1A33",
    pads: "#13294B", shoes: "#FFFFFF", hair: "#1A1410", focus: "#FFD23F",
    band: "#10284D", bandText: "#FFFFFF", bandSoft: "#B8C4D9", led: "#FFD23F", zoneA: "#FFD23F", zoneB: "#FFFFFF",
  },
};

export const themes: Theme[] = [locker, hall, night, broadcast];

export function themeById(id: string): Theme {
  return themes.find((t) => t.id === id) ?? locker;
}

/** Writes a theme's colours as `--c-<name>` variables and the colour scheme on the document root. */
export function applyTheme(t: Theme) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.colors)) root.style.setProperty(`--c-${k}`, v);
  root.style.colorScheme = t.dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.colors.surface);
}
