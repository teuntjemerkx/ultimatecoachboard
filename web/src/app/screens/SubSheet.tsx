import { useRef, useState, type ReactNode } from "react";
import { Icon } from "../ui/Icon";
import { PrizmCard } from "../ui/PrizmCard";
import { useFitColumns } from "../hooks/useViewport";
import { LiveEvent, TeamInSet, type CourtPosition, type PlayerID, type SubstitutionRefusal } from "../../core/match";
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

/** The word on a refused card's tab. */
function refusalTag(session: MatchSession, refusal: Refusal): string {
  if (refusal === "setOver") return "Set over";
  switch (refusal.reason) {
    case "limitReached": return "No subs left";
    case "outgoingDone": return "Stays on";
    case "incomingDone": return "Played";
    case "ownPositionOnly": {
      const n = session.number(refusal.partner!);
      return n === undefined ? "Not here" : `For #${n}`;
    }
    default: return "Not allowed";
  }
}

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

/** "OH1" → "OH": the role as the cards show it. */
const roleShort = (role?: string) => role?.replace(/\d+$/, "");

/**
 * A substitution for our team, in two taps: the player going off (the six on court, in their court layout), then the
 * player coming on (the bench). The rules are the match's own: a refused card is plain and says why on its tab, and a
 * tap on it explains in full.
 */
export function SubSheet({ session, onClose, onDone }: {
  session: MatchSession;
  onClose: () => void;
  /** After the substitution, with a line to confirm it ("#15 on for #12"). */
  onDone: (text: string) => void;
}) {
  const dispatch = useMatch((s) => s.dispatch);
  const [outgoing, setOutgoing] = useState<PlayerID | null>(null);
  const [message, setMessage] = useState("");
  const st = session.state, m = st.match, team = m.current.home;
  const line = st.setup.homeName ?? "Us";
  const liberoIn = m.liberoIn("home");
  const bench = st.homeBench;
  const used = team.substitutionsUsed, max = m.maxSubstitutionsPerSet;

  const card = (id: PlayerID, refusal: Refusal | undefined, extra: { tag?: string; line?: string }, onPick: () => void) => {
    const n = session.number(id);
    const name = session.name(id);
    const tag = refusal ? refusalTag(session, refusal) : extra.tag;
    return (
      <PrizmCard key={id} number={n ?? roleShort(m.displayRole(id, "home")) ?? "?"} name={name} role={roleShort(m.displayRole(id, "home"))}
                 line={extra.line ?? line} tier={refusal ? "base" : "prizm"} tag={tag}
                 label={`${session.who(id)}${tag ? `, ${tag}` : ""}${refusal ? `: ${refusalText(session, refusal, outgoing ?? id, outgoing ? id : undefined)}` : ""}`}
                 onSelect={onPick} />
    );
  };

  const pickOutgoing = (id: PlayerID) => {
    const refusal = st.substitutionRefusal("home", id);
    if (refusal) return setMessage(refusalText(session, refusal, id));
    setOutgoing(id);
    setMessage("");
  };

  const pickIncoming = (id: PlayerID) => {
    if (!outgoing) return;
    const refusal = st.substitutionRefusal("home", outgoing, id);
    if (refusal) return setMessage(refusalText(session, refusal, outgoing, id));
    dispatch(LiveEvent.substitution("home", outgoing, id));
    onDone(`${session.who(id)} on for ${session.who(outgoing)}`);
  };

  // What stays on screen under the cards when nothing was refused: the libero, or the rule for this substitute.
  const partner = outgoing ? m.substitutionPartner("home", outgoing) : undefined;
  const hint = outgoing
    ? (partner && !team.completed.has(outgoing) ? `${session.who(outgoing)} came on for ${session.who(partner)}: only ${session.who(partner)} can come back for them.`
      : "Tap the player who comes on.")
    : liberoIn ? `Libero ${session.who(liberoIn.libero)} plays for ${session.who(liberoIn.replaces)} in position ${liberoIn.position}; the libero changes by itself.`
      : "Tap the player who goes off.";

  return (
    <div className="sheet" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card stack pick-sheet sub-sheet" style={{ gap: 14 }} role="dialog" aria-label="Substitution">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
          <div className="stack" style={{ gap: 6, minWidth: 0 }}>
            <span className="label">Substitution · set {m.current.number} · {used} of {max} used</span>
            <h2 className="group-title" style={{ margin: 0, fontSize: 40, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {outgoing ? `Who comes on for ${session.who(outgoing)}?` : "Who goes off?"}
            </h2>
          </div>
          <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
            {outgoing && <button className="btn big" type="button" onClick={() => { setOutgoing(null); setMessage(""); }}><Icon name="back" /> Back</button>}
            <button className="btn big secondary" type="button" onClick={onClose}><Icon name="close" /> Cancel</button>
          </div>
        </div>

        {!outgoing ? (
          <Rack count={6} cols={3} net>
            {courtOrder.map((pos) => {
              const id = TeamInSet.playerAt(team, pos);
              const tag = liberoIn?.replaces === id ? "Libero in" : m.substitutionPartner("home", id) && !team.completed.has(id) ? "Sub" : undefined;
              return card(id, st.substitutionRefusal("home", id), { tag, line: `Position ${pos}` }, () => pickOutgoing(id));
            })}
          </Rack>
        ) : bench.length === 0 ? (
          <div className="empty" style={{ flex: 1 }}>
            Nobody on the bench. The team's players who are not in the lineup at the start appear here.
          </div>
        ) : (
          <Rack count={bench.length}>
            {bench.map((id) => card(id, st.substitutionRefusal("home", outgoing, id), { tag: partner === id ? "Returns" : undefined, line: "Bench" }, () => pickIncoming(id)))}
          </Rack>
        )}

        <p className={`sub-message${message ? " refused" : ""}`} role={message ? "alert" : undefined} aria-live="polite">
          {message || hint}
        </p>
      </div>
    </div>
  );
}
