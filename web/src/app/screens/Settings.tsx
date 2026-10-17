import { useEffect, useRef, useState } from "react";
import { Bar } from "../ui/Bar";
import { Choice } from "../ui/Choice";
import { Icon } from "../ui/Icon";
import { useNav } from "../store/nav";
import { useSettings } from "../store/settings";
import { applyTheme, themes, themeById } from "../theme";
import { makeBackup, restoreBackup, persist, type Backup } from "../store/db";
import { ScheduleSettings } from "../schedule/ScheduleSettings";

const sections = [
  { id: "team", title: "Team", icon: "shirt" },
  { id: "schedule", title: "Schedule", icon: "calendar" },
  { id: "look", title: "Look", icon: "palette" },
  { id: "backup", title: "Backup", icon: "download" },
  { id: "about", title: "About", icon: "info" },
] as const;
type Section = (typeof sections)[number]["id"];

/** Settings: the sections as big buttons on the left, one section at a time on the right. Nothing to scroll. */
export function Settings() {
  const route = useNav((s) => s.route);
  const asked = route.name === "settings" ? route.section : undefined;
  const [section, setSection] = useState<Section>(sections.some((s) => s.id === asked) ? (asked as Section) : "team");
  const current = sections.find((s) => s.id === section)!;

  return (
    <div className="screen">
      <Bar title="Settings" />
      <main className="fill settings-fill">
        <nav className="rail" aria-label="Settings sections">
          {sections.map((s) => (
            <button key={s.id} className="rail-btn" aria-pressed={s.id === section} onClick={() => setSection(s.id)}>
              <Icon name={s.icon} /> {s.title}
            </button>
          ))}
        </nav>
        <section className="locker-card settings-panel">
          <div className="plate-head"><span className="plate"><Icon name={current.icon} size={20} /> {current.title}</span></div>
          <div className="card-body">
            {section === "team" && <TeamSection />}
            {section === "schedule" && <ScheduleSettings />}
            {section === "look" && <LookSection />}
            {section === "backup" && <BackupSection />}
            {section === "about" && <AboutSection />}
          </div>
        </section>
      </main>
    </div>
  );
}

function TeamSection() {
  const s = useSettings();
  return (
    <>
      <label className="field">
        <span className="label">Team name</span>
        <input id="team-name" value={s.teamName} placeholder="Your team" onChange={(e) => s.set({ teamName: e.target.value })} />
      </label>
      <div className="stack" style={{ gap: 10 }}>
        <span className="label">Players</span>
        <Choice label="Players" value={s.women} onChange={(v) => s.set({ women: v })}
                options={[{ value: true, title: "Women" }, { value: false, title: "Men" }]} />
        <p className="muted" style={{ margin: 0 }}>{s.women ? "Net 2.24 m; women's player heights in 3D." : "Net 2.43 m; men's player heights in 3D."}</p>
      </div>
      <div className="stack" style={{ gap: 10 }}>
        <span className="label">Coach level</span>
        <Choice label="Coach level" value={s.advanced} onChange={(v) => s.set({ advanced: v })}
                options={[{ value: false, title: "Simple" }, { value: true, title: "Advanced" }]} />
        <p className="muted" style={{ margin: 0 }}>{s.advanced ? "All tools and detailed stats." : "The essentials, in plain words."}</p>
      </div>
    </>
  );
}

function LookSection() {
  const s = useSettings();
  return (
    <div className="theme-grid">
      {themes.map((t) => (
        <button key={t.id} className="theme-card" aria-pressed={s.themeId === t.id}
                onClick={() => { s.set({ themeId: t.id }); applyTheme(themeById(t.id)); }}>
          <div className="swatches">
            {[t.colors.bg, t.colors.surface, t.colors.primary, t.colors.home, t.colors.opponent].map((c, i) => <i key={i} style={{ background: c }} />)}
          </div>
          <strong>{t.name}</strong>
          <span>{t.summary}</span>
        </button>
      ))}
    </div>
  );
}

function BackupSection() {
  const advanced = useSettings((s) => s.advanced);
  const [usage, setUsage] = useState<string>("");
  const [message, setMessage] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => {
      if (e.usage != null) setUsage(`${(e.usage / 1e6).toFixed(1)} MB used on this iPad`);
    }).catch(() => {});
    persist();
  }, []);

  async function backup(withVideos: boolean) {
    if (busy) return;
    setBusy(true);
    setMessage("Making the backup…");
    try {
      const data = JSON.stringify(await makeBackup(withVideos));
      const name = `coach-board-${new Date().toISOString().slice(0, 10)}.json`;
      const file = new File([data], name, { type: "application/json" });
      try {
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: "Coach Board backup" });
          setMessage("Backup ready. Save it in Files or send it to yourself.");
          return;
        }
      } catch { /* the share sheet was closed; fall back to a download */ }
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setMessage("Backup downloaded.");
    } catch {
      setMessage(withVideos ? "The backup did not work. Try it without video clips (Advanced)." : "The backup did not work.");
    } finally {
      setBusy(false);
    }
  }

  async function restore(file: File) {
    if (!confirm(`Restore "${file.name}"? Players, matches, boards and videos from the file are added; newer ones on this iPad stay.`)) return;
    setBusy(true);
    setMessage("Restoring…");
    try {
      const n = await restoreBackup(JSON.parse(await file.text()) as Backup);
      setMessage(`Restored ${n} items. Restarting…`);
      // Every screen reads its data again, and the settings from the file take effect.
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      setMessage(e instanceof SyntaxError ? "That file could not be read." : e instanceof Error ? e.message : "That file could not be read.");
      setBusy(false);
    }
  }

  return (
    <>
      <p className="muted" style={{ margin: 0 }}>
        Everything stays on this iPad. Make a backup now and then (after a match day, say) and keep it in Files or iCloud Drive.
        {usage ? ` ${usage}.` : ""}
      </p>
      <div className="stack" style={{ gap: 12, maxWidth: 520 }}>
        <button className="btn primary" disabled={busy} onClick={() => backup(true)}><Icon name="download" /> Back up everything</button>
        {advanced && <button className="btn big" disabled={busy} onClick={() => backup(false)}>Back up without video clips</button>}
        <button className="btn secondary big" disabled={busy} onClick={() => fileRef.current?.click()}><Icon name="upload" /> Restore a backup</button>
        <input ref={fileRef} id="restore-file" type="file" accept="application/json,.json" hidden
               onChange={(e) => { const f = e.target.files?.[0]; if (f) restore(f); e.target.value = ""; }} />
      </div>
      {message && <p role="status" style={{ margin: 0, fontWeight: 600 }}>{message}</p>}
    </>
  );
}

function AboutSection() {
  return (
    <>
      <p style={{ margin: 0 }}>
        Coach Board: match scoring, tactics in 2D and 3D, and rallies rebuilt from video, for volleyball coaches. Everything
        works on this iPad, also without internet.
      </p>
      <p className="muted" style={{ margin: 0 }}>
        The 3D players are made with <a href="http://www.makehumancommunity.org" target="_blank" rel="noreferrer">MakeHuman</a>:
        bodies, skins, hair and eyes are CC0, and the kit is cut from the bodies. Shoes: “Running shoes” with the colours
        of “Tennis shoes”, both by punkduck,{" "}
        <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noreferrer">CC BY 3.0</a>, fitted to the
        players and recoloured.
      </p>
    </>
  );
}
