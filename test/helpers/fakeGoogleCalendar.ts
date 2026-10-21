// An in-memory Google Calendar (token endpoint + Calendar v3 events) for tests: enough for the
// first-party calendar client and tools (JD-77).
import { randomUUID } from "node:crypto";

type Json = Record<string, unknown>;

export const CREDS = { clientId: "client1", clientSecret: "secret1", refreshToken: "refresh1" };

export function fakeGoogleCalendar(calendarId = "primary") {
  const events = new Map<string, Json>();
  const calls: string[] = [];
  let tokenCalls = 0;

  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const ok = (json: Json, status = 200) => new Response(JSON.stringify(json), { status });
    const notFound = () => new Response(JSON.stringify({ error: { message: "Not Found" } }), { status: 404 });

    if (url === "https://oauth2.googleapis.com/token") {
      tokenCalls++;
      const params = new URLSearchParams(String(init.body));
      if (params.get("refresh_token") !== CREDS.refreshToken || params.get("client_id") !== CREDS.clientId) {
        return ok({ error: "invalid_grant", error_description: "bad refresh token" }, 400);
      }
      return ok({ access_token: `token-${tokenCalls}`, expires_in: 3600 });
    }

    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    if (!url.startsWith(base)) throw new Error(`fakeGoogleCalendar: unexpected URL ${url}`);
    const path = url.slice(base.length);
    calls.push(`${method} ${path.split("?")[0] || "/"}`);

    if (method === "GET" && (path === "" || path.startsWith("?"))) {
      return ok({ items: [...events.values()].sort((a, b) => String((a.start as Json)?.dateTime ?? (a.start as Json)?.date ?? "").localeCompare(String((b.start as Json)?.dateTime ?? (b.start as Json)?.date ?? ""))) });
    }
    if (method === "POST" && (path === "" || path.startsWith("?"))) {
      const body = JSON.parse(String(init.body)) as Json;
      const id = randomUUID().slice(0, 8);
      const event = { ...body, id, status: "confirmed", htmlLink: `https://calendar.google.com/event?eid=${id}` };
      events.set(id, event);
      return ok(event);
    }
    const m = path.match(/^\/([^?]+)/);
    const id = m ? m[1] : "";
    if (method === "GET") return events.has(id) ? ok(events.get(id)!) : notFound();
    if (method === "PATCH") {
      if (!events.has(id)) return notFound();
      const body = JSON.parse(String(init.body)) as Json;
      const merged = { ...events.get(id)!, ...body };
      events.set(id, merged);
      return ok(merged);
    }
    if (method === "DELETE") {
      if (!events.has(id)) return notFound();
      events.delete(id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`fakeGoogleCalendar: unhandled ${method} ${path}`);
  }) as unknown as typeof fetch;

  return { fetchImpl, events, calls, tokenCalls: () => tokenCalls };
}
