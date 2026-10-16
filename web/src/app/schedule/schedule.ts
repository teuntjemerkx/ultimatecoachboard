/**
 * The team's match schedule, read from a calendar feed: an iCal file (the Nevobo programme export
 * `…/programma.ics`, or any calendar's .ics link) or an RSS feed (`…/programma.rss`). Plain data, kept on the device.
 */
export interface ScheduledMatch {
  id: string;
  /** ISO date-time of the first serve. */
  start: string;
  end?: string;
  /** The event title as the feed gives it ("Saasveldia HS 1 - Krekkers HS 1"). */
  title: string;
  /** Both teams when the title reads "Home - Away" (the Nevobo convention: the home team first). */
  home?: string;
  away?: string;
  venue?: string;
  url?: string;
  cancelled?: boolean;
}

export interface Schedule {
  /** The link the coach pasted (webcal links stored as https). */
  url: string;
  /** The calendar's own name ("Wedstrijdprogramma Krekkers HS 1"). */
  name?: string;
  /** Our team as named in the feed, when the coach picked it; otherwise it is detected. */
  team?: string;
  fetchedAt: string;
  matches: ScheduledMatch[];
}

/** A match lasts about two hours when the feed gives no end. */
const defaultLength = 2 * 3600 * 1000;

// MARK: - Parsing

/** Reads an iCal or RSS feed. Throws when it holds no events. */
export function parseSchedule(text: string, url: string, now = new Date()): Schedule {
  const body = text.replace(/^﻿/, "").trimStart();
  const parsed = body.startsWith("BEGIN:VCALENDAR") ? parseICS(body) : parseRSS(body);
  if (parsed.matches.length === 0) throw new Error("No matches found in that schedule.");
  parsed.matches.sort((a, b) => a.start.localeCompare(b.start));
  return { url, name: parsed.name, fetchedAt: now.toISOString(), matches: parsed.matches };
}

interface ICSLine { name: string; params: Record<string, string>; value: string }

function icsLines(text: string): ICSLine[] {
  // Unfold: a line that starts with a space or tab continues the previous one (RFC 5545 3.1).
  const unfolded = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
  const out: ICSLine[] = [];
  for (const line of unfolded.split("\n")) {
    if (!line) continue;
    let colon = -1, quoted = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted;
      else if (line[i] === ":" && !quoted) { colon = i; break; }
    }
    if (colon < 0) continue;
    const [name, ...rest] = line.slice(0, colon).split(";");
    const params: Record<string, string> = {};
    for (const p of rest) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
    }
    out.push({ name: name.toUpperCase(), params, value: line.slice(colon + 1) });
  }
  return out;
}

const unescapeText = (v: string) => v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c)).trim();

/** An iCal date or date-time: UTC (Z), in a named time zone (TZID), floating (device time) or a whole day. */
export function icsDate(value: string, tzid?: string): Date | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"].map(Number);
  if (m[7]) return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (m[4] && tzid) {
    const t = zoned(y, mo, d, h, mi, s, tzid);
    if (t) return t;
  }
  return new Date(y, mo - 1, d, h, mi, s);
}

/** Wall-clock time in an IANA zone to an instant; undefined for zones the browser does not know. */
function zoned(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date | undefined {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return undefined;
  }
  const offset = (t: number) => {
    const parts = fmt.formatToParts(new Date(t));
    const g = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) - t;
  };
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = wall - offset(wall);
  t = wall - offset(t);
  return new Date(t);
}

function parseICS(text: string): { name?: string; matches: ScheduledMatch[] } {
  let name: string | undefined;
  const matches: ScheduledMatch[] = [];
  let ev: Partial<Record<string, ICSLine>> | null = null;
  for (const l of icsLines(text)) {
    if (l.name === "BEGIN" && l.value.toUpperCase() === "VEVENT") ev = {};
    else if (l.name === "END" && l.value.toUpperCase() === "VEVENT") {
      if (ev) {
        const m = icsMatch(ev);
        if (m) matches.push(m);
      }
      ev = null;
    } else if (ev) {
      if (!ev[l.name]) ev[l.name] = l;
    } else if (l.name === "X-WR-CALNAME") name = unescapeText(l.value);
  }
  return { name, matches };
}

function icsMatch(ev: Partial<Record<string, ICSLine>>): ScheduledMatch | undefined {
  const dt = ev.DTSTART;
  const start = dt ? icsDate(dt.value, dt.params.TZID) : undefined;
  if (!start) return undefined;
  const end = ev.DTEND ? icsDate(ev.DTEND.value, ev.DTEND.params.TZID) : undefined;
  const title = ev.SUMMARY ? unescapeText(ev.SUMMARY.value) : "Match";
  const m: ScheduledMatch = {
    id: ev.UID?.value.trim() || `${start.toISOString()}|${title}`,
    start: start.toISOString(),
    title,
    ...teamsOf(title),
  };
  if (end && end > start) m.end = end.toISOString();
  const venue = ev.LOCATION ? unescapeText(ev.LOCATION.value) : "";
  if (venue) m.venue = venue;
  if (ev.URL?.value.trim()) m.url = ev.URL.value.trim();
  if (ev.STATUS?.value.trim().toUpperCase() === "CANCELLED") m.cancelled = true;
  return m;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? decodeEntities(m[1]) : undefined;
}

function parseRSS(text: string): { name?: string; matches: ScheduledMatch[] } {
  const matches: ScheduledMatch[] = [];
  for (const item of text.match(/<item\b[\s\S]*?<\/item>/gi) ?? []) {
    const date = tag(item, "pubDate");
    const t = date ? Date.parse(date) : NaN;
    if (!Number.isFinite(t)) continue;
    // Nevobo titles start with the date and time: "16 okt 20:00: Saasveldia HS 1 - Krekkers HS 1".
    const title = (tag(item, "title") ?? "Match").replace(/^\s*\d{1,2}\s+\S+\s+\d{1,2}:\d{2}:\s*/, "");
    const start = new Date(t);
    const m: ScheduledMatch = {
      id: tag(item, "guid") || tag(item, "link") || `${start.toISOString()}|${title}`,
      start: start.toISOString(),
      title,
      ...teamsOf(title),
    };
    const venue = /Speellocatie:\s*(.+)$/i.exec(tag(item, "description") ?? "")?.[1]?.trim();
    if (venue) m.venue = venue;
    const link = tag(item, "link");
    if (link) m.url = link;
    if (/^(afgelast|geannuleerd|vervallen|cancel)/i.test(tag(item, "nevobo:status") ?? "")) m.cancelled = true;
    matches.push(m);
  }
  return { matches };
}

/** "Home - Away" as two teams; titles that do not split cleanly keep no teams. */
function teamsOf(title: string): { home?: string; away?: string } {
  const parts = title.split(" - ");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) return {};
  return { home: parts[0].trim(), away: parts[1].trim() };
}

// MARK: - Our team and the next matches

/** Every team named in the schedule, most frequent first. */
export function teamNames(s: Schedule): string[] {
  const counts = new Map<string, number>();
  for (const m of s.matches) for (const t of [m.home, m.away]) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

/**
 * Our team: the coach's pick, else the team the calendar is named after ("Wedstrijdprogramma Krekkers HS 1"), else
 * the team in most matches (a team's programme names it in every match).
 */
export function ourTeam(s: Schedule): string | undefined {
  const names = teamNames(s);
  if (s.team && names.includes(s.team)) return s.team;
  const own = s.name?.replace(/^wedstrijdprogramma\s+/i, "").trim();
  if (own) {
    if (names.includes(own)) return own;
    const club = names.find((n) => n.toLowerCase().startsWith(own.toLowerCase()));
    if (club) return club;
  }
  return names[0];
}

/** Who we play and whether at home; undefined parts when the title does not say. */
export function fixture(m: ScheduledMatch, team: string | undefined): { opponent?: string; home?: boolean } {
  if (team && m.home === team) return { opponent: m.away, home: true };
  if (team && m.away === team) return { opponent: m.home, home: false };
  return {};
}

/** Matches not yet over, soonest first (a match counts until its end, or two hours after the start). */
export function upcoming(s: Schedule | undefined, now = new Date()): ScheduledMatch[] {
  if (!s) return [];
  const t = now.getTime();
  return s.matches.filter((m) => (m.end ? Date.parse(m.end) : Date.parse(m.start) + defaultLength) >= t);
}

/** "Today", "Tomorrow" or "Sat 18 Oct", then the time: "Today · 20:00". */
export function when(m: ScheduledMatch, now = new Date()): string {
  const d = new Date(m.start);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  const date = diff === 0 ? "Today" : diff === 1 ? "Tomorrow"
    : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return `${date} · ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}
