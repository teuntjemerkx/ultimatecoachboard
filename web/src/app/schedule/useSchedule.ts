import { create } from "zustand";
import { parseSchedule, type Schedule } from "./schedule";

const KEY = "coachboard.schedule";
/** The schedule refreshes when the app opens and it is older than this. */
const staleAfter = 3 * 3600 * 1000;

function load(): Schedule | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Schedule) : undefined;
  } catch {
    return undefined;
  }
}

function store(s: Schedule | undefined) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the schedule lasts for this session */
  }
}

/** Fetches a feed through the app's schedule service (feeds send no CORS headers, so the browser cannot read them). */
export async function fetchSchedule(url: string): Promise<Schedule> {
  let res: Response;
  try {
    res = await fetch(`/api/schedule?url=${encodeURIComponent(url)}`);
  } catch {
    throw new Error("No internet connection. Try again when the iPad is online.");
  }
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    const message = type.includes("json") ? ((await res.json().catch(() => ({}))) as { error?: string }).error : undefined;
    throw new Error(message ?? "The schedule could not be fetched.");
  }
  if (type.includes("text/html")) throw new Error("The schedule service is not available here.");
  return parseSchedule(await res.text(), url);
}

interface ScheduleState {
  schedule?: Schedule;
  loading: boolean;
  error?: string;
  /** Links a schedule feed (replacing the previous one). Resolves true when it worked. */
  link(url: string): Promise<boolean>;
  /** Fetches the linked schedule again; without `force` only when it is stale. Keeps the old one when offline. */
  refresh(force?: boolean): Promise<void>;
  unlink(): void;
  setTeam(team: string | undefined): void;
}

export const useSchedule = create<ScheduleState>((set, get) => ({
  schedule: load(),
  loading: false,

  async link(raw) {
    const url = raw.trim().replace(/^webcals?:\/\//i, "https://");
    if (!url) return false;
    set({ loading: true, error: undefined });
    try {
      const schedule = await fetchSchedule(url);
      const previous = get().schedule;
      if (previous?.url === url && previous.team) schedule.team = previous.team;
      store(schedule);
      set({ schedule, loading: false });
      return true;
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : "The schedule could not be fetched." });
      return false;
    }
  },

  async refresh(force = false) {
    const { schedule, loading } = get();
    if (!schedule || loading) return;
    if (!force && Date.now() - Date.parse(schedule.fetchedAt) < staleAfter) return;
    if (!force && typeof navigator !== "undefined" && navigator.onLine === false) return;
    set({ loading: true, error: undefined });
    try {
      const next = await fetchSchedule(schedule.url);
      if (schedule.team) next.team = schedule.team;
      store(next);
      set({ schedule: next, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : "The schedule could not be refreshed." });
    }
  },

  unlink() {
    store(undefined);
    set({ schedule: undefined, error: undefined });
  },

  setTeam(team) {
    const s = get().schedule;
    if (!s) return;
    const next = { ...s, team };
    store(next);
    set({ schedule: next });
  },
}));
