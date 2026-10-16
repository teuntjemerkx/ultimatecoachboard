import { useEffect, useRef, useState } from "react";
import { Bar } from "../ui/Bar";
import { Choice } from "../ui/Choice";
import { Icon } from "../ui/Icon";
import { useSettings } from "../store/settings";
import { applyTheme, themes, themeById } from "../theme";
import { makeBackup, restoreBackup, persist, type Backup } from "../store/db";
import { ScheduleSettings } from "../schedule/ScheduleSettings";

/** Coach level, players, template, and the backup that keeps a season safe. */
export function Settings() {
  const s = useSettings();
  const [usage, setUsage] = useState<string>("");
  const [message, setMessage] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => {
      if (e.usage != null) setUsage(`${(e.usage / 1e6).toFixed(1)} MB used on this iPad`);
    }).catch(() => {});
    persist();
  }, []);

  async function backup(withVideos: boolean) {
    setMessage("Making the backup…");
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
  }

  async function restore(file: File) {
    try {
      const n = await restoreBackup(JSON.parse(await file.text()) as Backup);
      setMessage(`Restored ${n} items.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "That file could not be read.");
    }
  }

  return (
    <div className="screen">
      <Bar title="Settings" />
      <div className="scroll">
        <div className="page stack" style={{ gap: 28, maxWidth: 760 }}>
          <section className="stack" style={{ gap: 10 }}>
            <h2 className="group-title">Coach level</h2>
            <Choice label="Coach level" value={s.advanced} onChange={(v) => s.set({ advanced: v })}
                    options={[{ value: false, title: "Simple" }, { value: true, title: "Advanced" }]} />
            <p className="muted" style={{ margin: 0 }}>{s.advanced ? "All tools and detailed stats." : "The essentials, in plain words."}</p>
          </section>

          <section className="stack" style={{ gap: 10 }}>
            <h2 className="group-title">Players</h2>
            <Choice label="Players" value={s.women} onChange={(v) => s.set({ women: v })}
                    options={[{ value: true, title: "Women" }, { value: false, title: "Men" }]} />
            <p className="muted" style={{ margin: 0 }}>{s.women ? "Net 2.24 m; player heights of women's teams in 3D." : "Net 2.43 m; player heights of men's teams in 3D."}</p>
            <label className="field">
              <span className="label">Team name</span>
              <input id="team-name" value={s.teamName} placeholder="Your team" onChange={(e) => s.set({ teamName: e.target.value })} />
            </label>
          </section>

          <ScheduleSettings />

          <section className="stack" style={{ gap: 10 }}>
            <h2 className="group-title">Look</h2>
            <div className="grid-lockers">
              {themes.map((t) => (
                <button key={t.id} className="tile" style={{ minHeight: 0, outline: s.themeId === t.id ? "3px solid var(--c-focus)" : undefined }}
                        onClick={() => { s.set({ themeId: t.id }); applyTheme(themeById(t.id)); }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[t.colors.bg, t.colors.court, t.colors.home, t.colors.opponent].map((c, i) => (
                      <span key={i} style={{ width: 22, height: 22, borderRadius: 6, background: c, border: "1px solid var(--c-hairline)" }} />
                    ))}
                  </div>
                  <strong style={{ fontSize: 17 }}>{t.name}</strong>
                  <span style={{ fontSize: 14 }}>{t.summary}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="stack" style={{ gap: 10 }}>
            <h2 className="group-title">Backup</h2>
            <p className="muted" style={{ margin: 0 }}>
              Everything stays on this iPad. Make a backup now and then (after a match day, say) and keep it in Files or iCloud Drive.
              {usage ? ` ${usage}.` : ""}
            </p>
            <div className="row">
              <button className="btn secondary" onClick={() => backup(true)}><Icon name="download" /> Back up everything</button>
              {s.advanced && <button className="btn secondary" onClick={() => backup(false)}>Back up without video clips</button>}
              <button className="btn quiet" onClick={() => fileRef.current?.click()}><Icon name="upload" /> Restore a backup</button>
              <input ref={fileRef} id="restore-file" type="file" accept="application/json,.json" hidden
                     onChange={(e) => { const f = e.target.files?.[0]; if (f) restore(f); e.target.value = ""; }} />
            </div>
            {message && <p role="status" style={{ margin: 0 }}>{message}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
