import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../ui/Icon";
import { PrizmCard } from "../ui/PrizmCard";
import { useFitColumns } from "../hooks/useViewport";
import {
  LiveEvent, TeamInSet, newPlayerID, type CourtPosition, type PlayerID, type Side, type SubstitutionRefusal,
} from "../../core/match";
import { useMatch, type MatchSession } from "../match/session";

/** The six positions as they stand on court, seen from behind our end line: the front row at the net. */
const courtOrder: CourtPosition[] = [4, 3, 2, 5, 6, 1];

type Refusal = SubstitutionRefusal | "setOver";

/** What the coach reads when the rules refuse a substitution. */
export function refusalText(session: MatchSession, refusal: Refusal, outgoing: PlayerID, incoming?: PlayerID): string {
  const who = (id: PlayerID) => session.who(id);
  const m = session.state.match;
  if (refusal === "setOver") return "The set is over: substitutions wait for the next set.";
  switch (refusal.reason) {
    case "limitReached": return `All ${m.maxSubstitutionsPerSet} substitutions of set ${m.current.number} are used.`;
    case "notOnCourt": return `${who(outgoing)} is not on court.`;
    case "alreadyOnCourt": return `${incoming ? who(incoming) : "That player"} is already on court.`;
    case "libero": return "The libero is not part of a regular substitution; the libero changes by itself in the back row.";
    case "outgoingDone": return `${who(outgoing)} already went off and came back this set, so stays on until the set ends.`;
    case "incomingDone": return `${incoming ? who(incoming) : "That player"} already came on and went off this set: one turn per set.`;
    case "onlyPartner": return `${who(outgoing)} came on for ${who(refusal.partner!)}: only ${who(refusal.partner!)} can come back for them.`;
    case "ownPositionOnly": return `${incoming ? who(incoming) : "That player"} can only come back in their own position, for ${who(refusal.partner!)}.`;
  }
}

/** "OH1" → "OH": the role as the cards show it. */
const roleShort = (role?: string) => role?.replace(/\d+$/, "");

/** A role as a word, for a card without a shirt number (their players when their lineup was not typed in). */
const roleWord: Record<string, string> = { S: "Setter", OH: "Outside", MB: "Middle", OPP: "Opposite", L: "Libero" };

/** The word on a refused card's tab. */
function refusalTag(session: MatchSession, side: Side, refusal: Refusal): string {
  if (refusal === "setOver") return "Set over";
  switch (refusal.reason) {
    case "limitReached": return "No subs left";
    case "outgoingDone": return "Stays on";
    case "incomingDone": return "Played";
    case "ownPositionOnly": {
      const n = session.number(refusal.partner!), role = roleShort(session.state.match.displayRole(refusal.partner!, side));
      return n !== undefined ? `For #${n}` : role ? `For ${role}` : "Not here";
    }
    default: return "Not allowed";
  }
}

/** The team's colour for what sits inside: violet for us, gold for them. */
const teamColours = (side: Side) => ({
  ["--team" as string]: side === "home" ? "var(--c-home)" : "var(--c-opponent)",
  ["--on-team" as string]: side === "home" ? "var(--c-onHome)" : "var(--c-onOpponent)",
}) as CSSProperties;

/** Cards as large as fit without scrolling; with `cols` in that many columns (the court layout), and with `net` the net over them. */
function Rack({ count, cols, net, children }: { count: number; cols?: number; net?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const fit = useFitColumns(ref, count, 1.4, 14, cols, net ? 44 : 0);
  return (
    <div className="card-rack" ref={ref}
         style={{ flex: 1, gridTemplateColumns: fit.width ? `repeat(${fit.cols}, ${fit.width}px)` : cols ? `repeat(${cols}, 1fr)` : undefined,
                  justifyContent: "center", overflow: fit.width ? "hidden" : "auto" }}>
      {net && <div className="sub-net" aria-hidden="true"><span className="label">Net</span><div className="net" /></div>}
      {children}
    </div>
  );
}

/** A shirt number on a big pad: two digits at most, shown in the team's colour, and the button that brings the player on. */
function NumberPad({ value, onChange, onDone }: { value: string; onChange: (v: string) => void; onDone: () => void }) {
  // A third digit starts a new number, and so does a digit after a lone 0.
  const digit = (k: number) => onChange(value.length >= 2 || value === "0" ? String(k) : value + k);
  return (
    <div className="sub-pad">
      <span className="label">Shirt number</span>
      <div className={`sub-readout${value ? "" : " empty"}`} aria-live="polite" aria-label={value ? `Number ${value}` : "No number yet"}>
        #{value}
      </div>
      <div className="numbers sub-keys" role="group" aria-label="Number pad">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => (
          <button key={k} type="button" className="btn" onClick={() => digit(k)}>{k}</button>
        ))}
        <button type="button" className="btn" disabled={!value} onClick={() => onChange(value.slice(0, -1))} aria-label="Delete">
          <Icon name="backspace" size={30} />
        </button>
        <button type="button" className="btn" onClick={() => digit(0)}>0</button>
        <button type="button" className="btn go" disabled={!value} onClick={onDone}>
          {value ? `#${value} on` : "On"}
        </button>
      </div>
    </div>
  );
}

/**
 * A substitution for either team, in two taps: Us or Them, the player going off (the six on court, in their court
 * layout), then the player coming on: from the bench, or typed on a number pad (their players, and ours who are not in
 * the team). The rules are the match's own: a refused card is plain and says why on its tab, and a tap on it explains in
 * full.
 */
export function SubSheet({ session, onClose, onDone }: {
  session: MatchSession;
  onClose: () => void;
  /** After the substitution, with a line to confirm it ("#15 on for #12"). */
  onDone: (text: string) => void;
}) {
  const dispatch = useMatch((s) => s.dispatch);
  const [side, setSide] = useState<Side>("home");
  const [outgoing, setOutgoing] = useState<PlayerID | null>(null);
  const [typed, setTyped] = useState("");
  const [typing, setTyping] = useState(false);
  const [message, setMessage] = useState("");
  const st = session.state, m = st.match, team = m.current[side];
  const ours = side === "home";
  const names: Record<Side, string> = { home: st.setup.homeName ?? "Us", opponent: st.setup.opponentName ?? "Them" };
  const liberoIn = m.liberoIn(side);
  const bench = st.bench(side);
  // A substitute going off makes way only for the starter they replaced; no number to type then.
  const partner = outgoing ? m.substitutionPartner(side, outgoing) : undefined;
  const onlyPartner = outgoing !== null && partner !== undefined && !team.completed.has(outgoing);
  // Their players come on by number; ours too when one is not in the team, or nobody is on the bench.
  const pad = outgoing !== null && !onlyPartner && (!ours || typing || bench.length === 0);

  const reset = () => { setOutgoing(null); setTyped(""); setTyping(false); setMessage(""); };
  const choose = (s: Side) => { if (s !== side) { setSide(s); reset(); } };

  const card = (id: PlayerID, refusal: Refusal | undefined, extra: { tag?: string; line?: string }, onPick: () => void) => {
    const n = session.number(id);
    const role = roleShort(m.displayRole(id, side));
    const name = session.name(id) ?? (n === undefined && role ? roleWord[role] : undefined);
    const tag = refusal ? refusalTag(session, side, refusal) : extra.tag;
    return (
      <PrizmCard key={id} number={n ?? role ?? "?"} name={name} role={role} line={extra.line ?? names[side]}
                 tier={refusal ? "base" : ours ? "prizm" : "gold"} tag={tag} className={ours ? undefined : "their-card"}
                 label={`${session.who(id)}${tag ? `, ${tag}` : ""}${refusal ? `: ${refusalText(session, refusal, outgoing ?? id, outgoing ? id : undefined)}` : ""}`}
                 onSelect={onPick} />
    );
  };

  const pickOutgoing = (id: PlayerID) => {
    const refusal = st.substitutionRefusal(side, id);
    if (refusal) return setMessage(refusalText(session, refusal, id));
    setOutgoing(id);
    setMessage("");
  };

  /** Brings `incoming` on; `number` when they are new to the match. */
  const bringOn = (incoming: PlayerID, number?: number) => {
    if (!outgoing) return;
    const refusal = st.substitutionRefusal(side, outgoing, incoming);
    if (refusal) return setMessage(refusalText(session, refusal, outgoing, incoming));
    const off = session.who(outgoing);
    dispatch(LiveEvent.substitution(side, outgoing, incoming, number === undefined ? undefined : { number }));
    const text = `${session.who(incoming)} on for ${off}`;
    onDone(ours ? text : `${names.opponent}: ${text}`);
  };

  // A number the match knows for this team is that player (on court, on the bench, typed in earlier); else a new one.
  const bringOnTyped = () => {
    const n = Number(typed);
    if (typed === "" || !Number.isInteger(n)) return;
    const known = st.playerWithNumber(side, n);
    bringOn(known ?? newPlayerID(), known === undefined ? n : undefined);
  };

  // What stays on screen under the cards when nothing was refused: the libero, or the rule for this substitute.
  const hint = outgoing
    ? (onlyPartner ? `${session.who(outgoing)} came on for ${session.who(partner!)}: only ${session.who(partner!)} can come back for them.`
      : !ours ? (bench.length ? "Tap their player who comes back, or type the number of the one who comes on." : "Type the number of their player who comes on.")
        : pad ? (bench.length ? "Type the number of the player who comes on, or tap one on the bench." : "Type the number of the player who comes on.")
          : "Tap the player who comes on.")
    : liberoIn ? `Libero ${session.who(liberoIn.libero)} plays for ${session.who(liberoIn.replaces)} in position ${liberoIn.position}; the libero changes by itself.`
      : ours ? "Tap the player who goes off." : "Tap their player who goes off.";

  const benchCards = bench.length > 0 && (
    <Rack count={bench.length}>
      {bench.map((id) => card(id, st.substitutionRefusal(side, outgoing!, id),
                              { tag: partner === id ? "Returns" : undefined, line: ours ? "Bench" : "Went off" },
                              () => bringOn(id)))}
    </Rack>
  );

  return (
    <div className="sheet" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card stack pick-sheet sub-sheet" style={{ gap: 14, ...teamColours(side) }} role="dialog" aria-label="Substitution">
        <div className="sub-head">
          <div className="team-switch" role="group" aria-label="Whose substitution">
            {(["home", "opponent"] as Side[]).map((s) => (
              <button key={s} type="button" aria-pressed={side === s} onClick={() => choose(s)} style={teamColours(s)}
                      aria-label={`${s === "home" ? "Us" : "Them"}, ${names[s]}: ${m.substitutionsLeft(s)} of ${m.maxSubstitutionsPerSet} substitutions left`}>
                <span className="t">{s === "home" ? "Us" : "Them"}</span>
                <small><span className="who">{names[s]}</span> · {m.substitutionsLeft(s)} of {m.maxSubstitutionsPerSet} left</small>
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
            {outgoing && <button className="btn big" type="button" onClick={reset}><Icon name="back" /> Back</button>}
            <button className="btn big secondary" type="button" onClick={onClose}><Icon name="close" /> Cancel</button>
          </div>
        </div>
        <h2 className="group-title" style={{ margin: 0, fontSize: 40, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          <span className="sub-set">Set {m.current.number}</span>
          {outgoing ? `Who comes on for ${session.who(outgoing)}?` : "Who goes off?"}
        </h2>

        {!outgoing ? (
          <Rack count={6} cols={3} net>
            {courtOrder.map((pos) => {
              const id = TeamInSet.playerAt(team, pos);
              const tag = liberoIn?.replaces === id ? "Libero in" : m.substitutionPartner(side, id) && !team.completed.has(id) ? "Sub" : undefined;
              return card(id, st.substitutionRefusal(side, id), { tag, line: `Position ${pos}` }, () => pickOutgoing(id));
            })}
          </Rack>
        ) : pad ? (
          <div className="sub-incoming">
            {benchCards || (
              <div className="empty sub-empty">
                {ours ? "Nobody on the bench. The team's players who are not in the lineup at the start appear here."
                  : "Their players who go off wait here to come back."}
              </div>
            )}
            <NumberPad value={typed} onChange={(v) => { setTyped(v); setMessage(""); }} onDone={bringOnTyped} />
          </div>
        ) : benchCards}

        <div className="sub-foot">
          <p className={`sub-message${message ? " refused" : ""}`} role={message ? "alert" : undefined} aria-live="polite">
            {message || hint}
          </p>
          {outgoing && ours && !pad && !onlyPartner && (
            <button className="btn big secondary" type="button" onClick={() => { setTyping(true); setMessage(""); }}>
              <Icon name="shirt" /> Not in the team?
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
