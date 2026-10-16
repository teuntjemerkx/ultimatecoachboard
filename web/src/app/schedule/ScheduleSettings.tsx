import { useState, type FormEvent } from "react";
import { ourTeam, teamNames, upcoming } from "./schedule";
import { useSchedule } from "./useSchedule";

/** "today 18:20", "yesterday 09:05" or "12 Oct 18:20". */
export function updatedAt(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `yesterday ${time}`;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}

/** Settings > Match schedule: link the team's programme once (a Nevobo iCal link, say); it refreshes by itself. */
export function ScheduleSettings() {
  const { schedule, loading, error, link, refresh, unlink, setTeam } = useSchedule();
  const [url, setUrl] = useState(schedule?.url ?? "");
  const [done, setDone] = useState("");
  const team = schedule ? ourTeam(schedule) : undefined;
  const names = schedule ? teamNames(schedule) : [];
  const typed = url.trim().replace(/^webcals?:\/\//i, "https://");
  const changed = typed !== "" && typed !== schedule?.url;
  const coming = upcoming(schedule).length;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setDone("");
    if (await link(url)) {
      setUrl(typed);
      setDone("Schedule linked.");
    }
  }

  return (
    <section className="stack" style={{ gap: 10 }}>
      <h2 className="group-title">Match schedule</h2>
      <p className="muted" style={{ margin: 0 }}>
        Paste the link to your team's programme: the iCal link (.ics) of the Nevobo export, or any calendar's iCal or RSS link.
        Your next matches then show on the start screen and fill in the opponent of a new match.
      </p>
      <form className="stack" style={{ gap: 10 }} onSubmit={submit}>
        <label className="field">
          <span className="label">Schedule link</span>
          <input id="schedule-url" type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                 placeholder="https://api.nevobo.nl/export/team/…/programma.ics" value={url}
                 onChange={(e) => { setUrl(e.target.value); setDone(""); }} />
        </label>
        <div className="row">
          {(changed || !schedule) && (
            <button className="btn secondary" type="submit" disabled={loading || typed === ""}>
              {loading ? "Fetching the schedule…" : schedule ? "Use this link" : "Link schedule"}
            </button>
          )}
          {schedule && !changed && (
            <button className="btn secondary" type="button" disabled={loading} onClick={() => { setDone(""); void refresh(true); }}>
              {loading ? "Updating…" : "Update now"}
            </button>
          )}
          {schedule && (
            <button className="btn quiet danger" type="button" onClick={() => { unlink(); setUrl(""); setDone(""); }}>Remove</button>
          )}
        </div>
      </form>
      {schedule && (
        <p className="muted" style={{ margin: 0 }} data-testid="schedule-status">
          {schedule.matches.length} {schedule.matches.length === 1 ? "match" : "matches"}, {coming} still to play
          {" · "}updated {updatedAt(schedule.fetchedAt)}. It updates by itself when you open the app online.
        </p>
      )}
      {schedule && names.length > 1 && (
        <label className="field">
          <span className="label">Our team in the schedule</span>
          <select id="schedule-team" value={team ?? ""} onChange={(e) => setTeam(e.target.value || undefined)}>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
      {error && <p role="alert" style={{ margin: 0, color: "var(--c-fault)" }}>{error}</p>}
      {done && !error && <p role="status" style={{ margin: 0 }}>{done}</p>}
    </section>
  );
}
