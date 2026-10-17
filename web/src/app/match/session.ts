import { create } from "zustand";
import {
  CourtPosition, JournalCodec, JournalPayload, JournalRecordType, JournalWriter, LineupBuilder, LiveState, MatchStartedPayload,
  RuleCourtProfile, TeamSystem, TemplateLibrary, newPlayerID, type CoachMode, type JournalHeader, type LiveEvent, type PlayerID,
  type Side,
} from "../../core/match";
import { get, put } from "../store/db";

/** A player chosen for the match: from the roster, or a number typed on the spot. */
export interface PlayerRef { id: string; number: number; name?: string }

/** What the coach picks before the first serve (Screen 2). */
export interface MatchSetup {
  homeName: string;
  opponentName: string;
  system: TeamSystem;
  /** Our players at P1...P6 (index 0 = P1). */
  slots: (PlayerRef | null)[];
  libero?: PlayerRef;
  bench: PlayerRef[];
  /** The court position (1...6) of our setter, for systems with one. */
  setterPosition: number;
  /** Their numbers at P1...P6, when known. */
  opponentNumbers: (number | null)[];
  opponentSetterPosition: number;
  firstServer: Side;
  netHeight: number;
  mode: CoachMode;
}

/** A match as stored on the device: its journal file (Appendix B3) plus a summary for lists. */
export interface MatchRecord {
  id: string;
  createdAt: string;
  homeName: string;
  opponent: string;
  /** The journal's bytes, base64. */
  journal: string;
  finished: boolean;
  /** "18–21" in the current set, or the final sets "3–1". */
  score: string;
  sets: string;
  setsWon: { home: number; opponent: number };
}

const profile = RuleCourtProfile.fivbSenior();

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function profileHash(): Promise<Uint8Array> {
  const data = new TextEncoder().encode(JSON.stringify(RuleCourtProfile.encode(profile)));
  try {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  } catch {
    return new Uint8Array(32);
  }
}

const now = () => Date.now() / 1000;
const wallClock = () => Date.now() * 1e6;

/** A match being played: the pure reducer, its journal, and the record on the device. */
export class MatchSession {
  private constructor(readonly id: string, public state: LiveState, private readonly writer: JournalWriter,
                      private readonly createdAt: string) {}

  /** Starts a match from the setup, as the iPad app does: team sheets from the template's lineup order. */
  static async start(setup: MatchSetup): Promise<MatchSession> {
    const homeTemplate = TemplateLibrary.template(TeamSystem.templateID(setup.system));
    const opponentTemplate = TemplateLibrary.template(MatchStartedPayload.defaultOpponentTemplateID);
    const jerseys: Record<PlayerID, number> = {};
    const names: Record<PlayerID, string> = {};
    const note = (p: PlayerRef) => {
      jerseys[p.id] = p.number;
      if (p.name) names[p.id] = p.name;
    };
    const homePlayers = new Map<CourtPosition, PlayerID>();
    setup.slots.forEach((p, i) => {
      if (!p) throw new Error("Put six players on court.");
      homePlayers.set((i + 1) as CourtPosition, p.id);
      note(p);
    });
    if (setup.libero) note(setup.libero);
    setup.bench.forEach(note);
    const hasSetter = TeamSystem.hasSetter(setup.system);
    const home = LineupBuilder.sheet({
      players: homePlayers, order: homeTemplate.lineupOrder,
      anchor: (hasSetter ? setup.setterPosition : 1) as CourtPosition,
      libero: homeTemplate.libero ? setup.libero?.id : undefined, liberoReplaces: homeTemplate.libero?.replaces ?? [],
    });
    const opponentPlayers = new Map<CourtPosition, PlayerID>();
    for (const pos of CourtPosition.allCases) {
      const id = newPlayerID();
      opponentPlayers.set(pos, id);
      const n = setup.opponentNumbers[pos - 1];
      if (n != null) jerseys[id] = n;
    }
    const opponent = LineupBuilder.sheet({
      players: opponentPlayers, order: opponentTemplate.lineupOrder, anchor: setup.opponentSetterPosition as CourtPosition,
      liberoReplaces: opponentTemplate.libero?.replaces ?? [],
    });
    const payload: MatchStartedPayload = {
      profileName: profile.name, home, opponent, firstServer: setup.firstServer, mode: setup.mode, templateID: homeTemplate.id,
      homeName: setup.homeName, opponentName: setup.opponentName, jerseys, netHeight: setup.netHeight,
      opponentTemplateID: opponentTemplate.id, names: Object.keys(names).length ? names : undefined,
      homeBench: setup.bench.map((b) => b.id),
    };
    const id = crypto.randomUUID().toUpperCase();
    const header: JournalHeader = { version: 1, flags: 0, matchID: id, createdAtNanoseconds: wallClock(), profileHash: await profileHash() };
    const writer = new JournalWriter(header);
    writer.append(JournalRecordType.matchStarted, JournalPayload.encode(MatchStartedPayload, payload), wallClock());
    writer.commit();
    const state = new LiveState({ setup: payload, profile, template: homeTemplate, opponentTemplate, nextSeq: writer.nextSeq });
    const session = new MatchSession(id, state, writer, new Date().toISOString());
    await session.write();
    return session;
  }

  /** Opens a stored match where it was left (also after the iPad was switched off mid-set). */
  static async open(id: string): Promise<MatchSession | undefined> {
    const rec = await get<MatchRecord>("matches", id);
    if (!rec) return undefined;
    const bytes = fromBase64(rec.journal);
    const read = JournalCodec.read(bytes);
    const state = LiveState.replay(read.records, profile);
    if (!state) return undefined;
    return new MatchSession(id, state, new JournalWriter(read.header, bytes), rec.createdAt);
  }

  get records() { return this.writer.records; }

  /** One event through the reducer; journal records are kept, and saved when the reducer commits them. */
  dispatch(event: LiveEvent): string[] {
    const haptics: string[] = [];
    let commit = false;
    for (const effect of this.state.reduce(event)) {
      if (effect.kind === "journal") this.writer.append(effect.type, effect.payload, wallClock());
      else if (effect.kind === "commitJournal") commit = true;
      else haptics.push(effect.pattern);
    }
    if (commit && this.writer.commit().length) void this.save();
    return haptics;
  }

  /** True while the last save failed: the match is on screen but not yet stored on the iPad. */
  unsaved = false;
  /** Called when `unsaved` changes, so the screen can show it. */
  onSaveChange?: () => void;
  private saving: Promise<void> = Promise.resolve();

  /**
   * Saves now; the database keeps writes in the order they were made, so an older state never lands last. A failure
   * shows on screen instead of vanishing.
   */
  save(): Promise<void> {
    this.saving = this.write().then(
      () => { if (this.unsaved) { this.unsaved = false; this.onSaveChange?.(); } },
      () => { if (!this.unsaved) { this.unsaved = true; this.onSaveChange?.(); } },
    );
    return this.saving;
  }

  /** Stores everything now, including notes the reducer would commit with the next rally (the app is going away). */
  flush(): Promise<void> {
    return this.writer.commit().length || this.unsaved ? this.save() : this.saving;
  }

  /** The label on a player's token: the jersey number, else the role. */
  label(player: PlayerID, role: string): string {
    const n = this.state.setup.jerseys?.[player];
    return n !== undefined ? String(n) : role;
  }

  name(player: PlayerID): string | undefined { return this.state.setup.names?.[player]; }

  number(player: PlayerID): number | undefined { return this.state.setup.jerseys?.[player]; }

  /** A player as the coach names them: "#12 Anna", "#12", or the role when no number is known. */
  who(player: PlayerID): string {
    const n = this.number(player), name = this.name(player);
    if (n === undefined) return name ?? this.state.match.displayRole(player, "home") ?? "a player";
    return `#${n}${name ? ` ${name}` : ""}`;
  }

  /** One write of the match record. */
  async write() {
    const m = this.state.match;
    const sets = `${m.setsWon("home")}–${m.setsWon("opponent")}`;
    const record: MatchRecord = {
      id: this.id, createdAt: this.createdAt, homeName: this.state.setup.homeName ?? "Us",
      opponent: this.state.setup.opponentName ?? "Opponent", journal: toBase64(this.writer.data), finished: m.isOver,
      score: `${m.current.score.home}–${m.current.score.opponent}`, sets,
      setsWon: { home: m.setsWon("home"), opponent: m.setsWon("opponent") },
    };
    await put("matches", record);
  }
}

export { now as liveClock };

/** The open match for the live screen; `version` changes after every event so views redraw. */
interface MatchStore {
  session?: MatchSession;
  version: number;
  open(session: MatchSession): void;
  dispatch(event: LiveEvent): void;
}

export const useMatch = create<MatchStore>((set, getState) => ({
  version: 0,
  open(session) {
    session.onSaveChange = () => set({ version: getState().version + 1 });
    set({ session, version: getState().version + 1 });
  },
  dispatch(event) {
    const s = getState().session;
    if (!s) return;
    const haptics = s.dispatch(event);
    if (haptics.length && "vibrate" in navigator) navigator.vibrate?.(haptics.includes("sideOut") ? [12, 40, 12] : 10);
    set({ version: getState().version + 1 });
  },
}));
