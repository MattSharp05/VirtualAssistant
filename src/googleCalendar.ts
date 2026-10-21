// First-party Google Calendar (JD-77): a thin REST client (same shape as NotionApi in
// notionWrite.ts) using an OAuth refresh token to mint access tokens, then calling the Calendar v3
// API directly with the global fetch — no new dependency, consistent with how Notion is done here.
// Replaces the claude.ai Google Calendar connector, whose write tools kept dropping out.

import { JarvisError } from "./jarvis.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";

export type Json = Record<string, unknown>;

export interface GoogleCalendarCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Default "primary". */
  calendarId?: string;
}

export interface CalendarAttendeeApi {
  email: string;
  displayName?: string;
  self?: boolean;
  responseStatus?: "needsAction" | "accepted" | "declined" | "tentative";
}

/** Google's event resource, trimmed to the fields JARVIS reads or writes. */
export interface CalendarEventApi {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: CalendarAttendeeApi[];
  htmlLink?: string;
  status?: string;
}

/** A thin Calendar v3 client; `fetchImpl` is injectable for tests (NotionApi's pattern). */
export class GoogleCalendarApi {
  private accessToken?: string;
  private expiresAt = 0;

  constructor(
    private readonly creds: GoogleCalendarCreds,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  calendarId(): string {
    return this.creds.calendarId ?? "primary";
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.now() < this.expiresAt - 30_000) return this.accessToken;
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new JarvisError(`Google Calendar token refresh failed: ${json.error_description ?? json.error ?? res.status}`);
    }
    this.accessToken = json.access_token;
    this.expiresAt = this.now() + (json.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  private async call(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: Json): Promise<Json> {
    const token = await this.token();
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const json = (text ? JSON.parse(text) : {}) as Json;
    if (!res.ok) {
      const message = ((json.error as Json | undefined)?.message as string | undefined) ?? res.statusText;
      throw new JarvisError(`Google Calendar ${res.status}: ${message}`);
    }
    return json;
  }

  /** Events starting in [timeMin, timeMax), expanded (no recurrence masters), earliest first. */
  async listEvents(timeMin: string, timeMax: string, maxResults = 50): Promise<CalendarEventApi[]> {
    const q = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: String(maxResults) });
    const res = await this.call("GET", `/calendars/${encodeURIComponent(this.calendarId())}/events?${q}`);
    return (res.items as CalendarEventApi[] | undefined) ?? [];
  }

  async getEvent(eventId: string): Promise<CalendarEventApi> {
    return (await this.call("GET", `/calendars/${encodeURIComponent(this.calendarId())}/events/${encodeURIComponent(eventId)}`)) as CalendarEventApi;
  }

  async createEvent(body: CalendarEventApi): Promise<CalendarEventApi> {
    return (await this.call("POST", `/calendars/${encodeURIComponent(this.calendarId())}/events?sendUpdates=all`, body as Json)) as CalendarEventApi;
  }

  async updateEvent(eventId: string, patch: CalendarEventApi): Promise<CalendarEventApi> {
    return (await this.call("PATCH", `/calendars/${encodeURIComponent(this.calendarId())}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, patch as Json)) as CalendarEventApi;
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.call("DELETE", `/calendars/${encodeURIComponent(this.calendarId())}/events/${encodeURIComponent(eventId)}?sendUpdates=all`);
  }

  /** PATCHes just the self attendee's responseStatus (the API replaces the whole attendees array on PATCH, so this reads it first). */
  async respond(eventId: string, responseStatus: CalendarAttendeeApi["responseStatus"]): Promise<CalendarEventApi> {
    const event = await this.getEvent(eventId);
    const attendees = event.attendees ?? [];
    const i = attendees.findIndex((a) => a.self);
    if (i < 0) throw new JarvisError(`You're not listed as a guest on that event, so there's nothing to RSVP.`);
    const next = attendees.map((a, n) => (n === i ? { ...a, responseStatus } : a));
    return this.updateEvent(eventId, { attendees: next });
  }
}

/** A new client, or a clear error if Matthew hasn't finished setup (`npm run setup:calendar`). */
export function googleCalendarApi(creds: GoogleCalendarCreds | undefined): GoogleCalendarApi {
  if (!creds) {
    throw new JarvisError(
      "Google Calendar isn't connected yet (GOOGLE_CALENDAR_CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN aren't set; run `npm run setup:calendar` once to get a refresh token).",
    );
  }
  return new GoogleCalendarApi(creds);
}

const clients = new WeakMap<object, GoogleCalendarApi>();

/** For tests: inject a client (e.g. against a fake fetch) instead of the real one. */
export function useGoogleCalendar(owner: object, api: GoogleCalendarApi): void {
  clients.set(owner, api);
}

/** One client per owning Jarvis (so its access-token cache is reused across calls); built on first use. */
export function googleCalendarFor(owner: object, creds: GoogleCalendarCreds | undefined): GoogleCalendarApi {
  let api = clients.get(owner);
  if (!api) {
    api = googleCalendarApi(creds);
    clients.set(owner, api);
  }
  return api;
}

/** The attendee marked `self: true` on an event, if any. */
export function selfAttendee(event: CalendarEventApi): CalendarAttendeeApi | undefined {
  return event.attendees?.find((a) => a.self);
}
