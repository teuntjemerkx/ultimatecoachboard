import { feedURL } from "../../../api/schedule";
import { fixture, icsDate, ourTeam, parseSchedule, teamNames, upcoming } from "./schedule";

// The shape of the Nevobo programme export (api.nevobo.nl/export/team/…/programma.ics), folded lines included.
const ics = [
  "BEGIN:VCALENDAR",
  "PRODID:api.nevobo.nl",
  "VERSION:2.0",
  "X-WR-CALNAME:Wedstrijdprogramma Eagles HS 1",
  "BEGIN:VEVENT",
  "UID:4138ec43edd1e4d67429f1afe5265442",
  "SUMMARY:Lindenhof HS 1 - Eagles HS 1",
  "DESCRIPTION:[20:00] Wedstrijd: 5000H1B   AG\\, Datum: vrijdag 16 oktober\\, 2",
  " 0:00",
  "URL:https://api.nevobo.nl/permalink/wedstrijd/1993626",
  "DTSTART:20261016T180000Z",
  "DTEND:20261016T200000Z",
  "LOCATION:Sporthal Lindenhof\\, Gravenallee 8\\, 7597LR  Saasveld",
  "X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS=Sporthal Lindenhof\\, Grave",
  " nallee 8;X-TITLE=Sporthal Lindenhof:geo:52.329140,6.805870",
  "STATUS:CONFIRMED",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:c66c56a8dbb7299af49acafd8f452d36",
  "SUMMARY:Eagles HS 1 - Weghorst Makelaardij WVC Volley HS 2",
  "DTSTART:20261030T201500Z",
  "DTEND:20261030T221500Z",
  "LOCATION:De Haambrink\\, Almeloseweg 211\\, 7614LA  Mariaparochie",
  "STATUS:CANCELLED",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:nevobo="https://www.api.nevobo.nl/rss/">
  <channel>
    <title>RSS feed Nederlandse Volleybalbond</title>
    <item>
      <title><![CDATA[16 okt 20:00: Lindenhof HS 1 - Eagles HS 1]]></title>
      <link>https://api.nevobo.nl/permalink/wedstrijd/1993626</link>
      <guid>https://api.nevobo.nl/permalink/wedstrijd/1993626</guid>
      <description><![CDATA[Wedstrijd: 5000H1B   AG, Datum: vrijdag 16 oktober, 20:00, Speellocatie: Sporthal Lindenhof, Gravenallee 8, 7597LR  Saasveld]]></description>
      <pubDate>Fri, 16 Oct 2026 20:00:00 +0200</pubDate>
      <nevobo:status>gepland</nevobo:status>
    </item>
    <item>
      <title><![CDATA[30 okt 21:15: Eagles HS 1 - De Spikers &amp; Co HS 2]]></title>
      <guid>https://api.nevobo.nl/permalink/wedstrijd/1993783</guid>
      <description><![CDATA[Wedstrijd: 5000H1B   GA, Speellocatie: De Haambrink, Almeloseweg 211]]></description>
      <pubDate>Fri, 30 Oct 2026 21:15:00 +0100</pubDate>
      <nevobo:status>gepland</nevobo:status>
    </item>
  </channel>
</rss>`;

describe("schedule feeds", () => {
  it("reads the Nevobo iCal export", () => {
    const s = parseSchedule(ics, "https://api.nevobo.nl/export/team/X/heren/1/programma.ics");
    expect(s.name).toBe("Wedstrijdprogramma Eagles HS 1");
    expect(s.matches).toHaveLength(2);
    const [a, b] = s.matches;
    expect(a.start).toBe("2026-10-16T18:00:00.000Z");
    expect(a.end).toBe("2026-10-16T20:00:00.000Z");
    expect(a.home).toBe("Lindenhof HS 1");
    expect(a.away).toBe("Eagles HS 1");
    expect(a.venue).toBe("Sporthal Lindenhof, Gravenallee 8, 7597LR  Saasveld");
    expect(a.url).toBe("https://api.nevobo.nl/permalink/wedstrijd/1993626");
    expect(a.cancelled).toBeUndefined();
    expect(b.cancelled).toBe(true);
    expect(ourTeam(s)).toBe("Eagles HS 1");
    expect(fixture(a, "Eagles HS 1")).toEqual({ opponent: "Lindenhof HS 1", home: false });
    expect(fixture(b, "Eagles HS 1")).toEqual({ opponent: "Weghorst Makelaardij WVC Volley HS 2", home: true });
  });

  it("reads the Nevobo RSS export", () => {
    const s = parseSchedule(rss, "https://api.nevobo.nl/export/team/X/heren/1/programma.rss");
    expect(s.matches.map((m) => m.start)).toEqual(["2026-10-16T18:00:00.000Z", "2026-10-30T20:15:00.000Z"]);
    expect(s.matches[0].title).toBe("Lindenhof HS 1 - Eagles HS 1");
    expect(s.matches[0].venue).toBe("Sporthal Lindenhof, Gravenallee 8, 7597LR  Saasveld");
    expect(s.matches[1].away).toBe("De Spikers & Co HS 2");
    // No calendar name in RSS: our team is the one in every match.
    expect(ourTeam(s)).toBe("Eagles HS 1");
    expect(teamNames(s)[0]).toBe("Eagles HS 1");
  });

  it("uses the coach's pick of our team", () => {
    const s = { ...parseSchedule(ics, "u"), team: "Lindenhof HS 1" };
    expect(ourTeam(s)).toBe("Lindenhof HS 1");
    expect(fixture(s.matches[0], "Lindenhof HS 1")).toEqual({ opponent: "Eagles HS 1", home: true });
  });

  it("keeps matches until they are over", () => {
    const s = parseSchedule(ics, "u");
    expect(upcoming(s, new Date("2026-10-16T19:00:00Z")).map((m) => m.id)).toHaveLength(2);
    expect(upcoming(s, new Date("2026-10-16T20:30:00Z")).map((m) => m.id)).toEqual(["c66c56a8dbb7299af49acafd8f452d36"]);
  });

  it("reads time zones and whole days", () => {
    expect(icsDate("20261016T200000", "Europe/Amsterdam")?.toISOString()).toBe("2026-10-16T18:00:00.000Z");
    expect(icsDate("20261230T200000", "Europe/Amsterdam")?.toISOString()).toBe("2026-12-30T19:00:00.000Z");
    expect(icsDate("20261016")?.getDate()).toBe(16);
    expect(icsDate("not a date")).toBeUndefined();
  });

  it("refuses feeds without matches", () => {
    expect(() => parseSchedule("BEGIN:VCALENDAR\r\nEND:VCALENDAR", "u")).toThrow(/No matches/);
  });
});

describe("schedule service", () => {
  it("takes public https and webcal links only", () => {
    expect(feedURL("webcal://api.nevobo.nl/export/team/X/heren/1/programma.ics")?.href)
      .toBe("https://api.nevobo.nl/export/team/X/heren/1/programma.ics");
    expect(feedURL("http://calendar.example.org/a.ics")?.protocol).toBe("https:");
    for (const bad of ["ftp://example.org/a.ics", "https://localhost/a.ics", "https://127.0.0.1/a.ics", "https://[::1]/a.ics",
      "https://intranet/a.ics", "https://user:pw@example.org/a.ics", "https://example.org:8443/a.ics", "nonsense"]) {
      expect(feedURL(bad)).toBeUndefined();
    }
  });
});
