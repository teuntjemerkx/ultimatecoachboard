/**
 * Fetches a match schedule (an iCal or RSS feed, such as the Nevobo programme export) for the app. The browser cannot
 * read those feeds itself: they send no CORS headers. Vercel serves this file as `/api/schedule?url=…`; the dev and
 * preview servers mount the same handler (vite.config.ts).
 */
const maxBytes = 2_000_000;
const timeoutMs = 10_000;
const maxRedirects = 3;

export function GET(request: Request): Promise<Response> {
  return scheduleProxy(request.url);
}

/** The feed address the coach pasted, made fetchable: `webcal:` links become https. Undefined when it cannot be used. */
export function feedURL(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/^webcals?:\/\//i, "https://"));
  } catch {
    return undefined;
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return undefined;
  const host = url.hostname.toLowerCase();
  // Only public names: no IP literals, no single-label or local hosts.
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost"
      || /^[\d.]+$/.test(host) || host.startsWith("[")) return undefined;
  return url;
}

export async function scheduleProxy(requestURL: string): Promise<Response> {
  const raw = new URL(requestURL).searchParams.get("url") ?? "";
  let target = feedURL(raw);
  if (!target) return problem(400, "That is not a web link to a schedule.");
  try {
    let res: Response | undefined;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      res = await fetch(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "text/calendar, application/rss+xml, application/xml, text/xml, */*;q=0.5", "user-agent": "CoachBoard/1.0" },
      });
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) break;
      const next = feedURL(new URL(location, target).toString());
      if (!next) return problem(502, "The schedule link sends us somewhere we cannot follow.");
      target = next;
      res = undefined;
    }
    if (!res) return problem(502, "The schedule link redirects too often.");
    if (!res.ok) return problem(502, res.status === 404 ? "No schedule found at that link." : `The schedule site answered ${res.status}.`);
    const text = await readCapped(res);
    if (text === undefined) return problem(502, "That schedule is too large.");
    const head = text.slice(0, 4000).replace(/^﻿/, "").trimStart();
    if (!head.startsWith("BEGIN:VCALENDAR") && !/<rss[\s>]|<feed[\s>]/i.test(head)) {
      return problem(422, "That link is not a calendar (iCal) or RSS feed.");
    }
    return new Response(text, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=0, s-maxage=900" },
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return problem(504, timedOut ? "The schedule site did not answer in time." : "The schedule could not be fetched.");
  }
}

async function readCapped(res: Response): Promise<string | undefined> {
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) return undefined;
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}

function problem(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
