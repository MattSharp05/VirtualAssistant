// npm run setup:calendar -- --client-id <id> --client-secret <secret>
// One-time OAuth consent for the first-party Google Calendar integration (JD-77). Run this on your
// own Mac (it needs a browser), not in the container: it opens a local loopback server, prints a
// Google sign-in URL, and once you approve it, prints the refresh token to put in .env as
// GOOGLE_CALENDAR_REFRESH_TOKEN (along with GOOGLE_CALENDAR_CLIENT_ID/SECRET). Create the OAuth
// client at console.cloud.google.com → APIs & Services → Credentials → Create OAuth client id →
// Desktop app, with the Calendar API enabled and your account added as a test user (or the app
// published) on the consent screen.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar";

export function authUrl(clientId: string, redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${q}`;
}

export async function exchangeCode(
  creds: { clientId: string; clientSecret: string },
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ refreshToken: string; accessToken: string }> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.refresh_token || !json.access_token) {
    throw new Error(
      `Google didn't return a refresh token (${json.error_description ?? json.error ?? res.status}). ` +
        "If you've authorized this app before, revoke it at myaccount.google.com/permissions and run setup again: Google only hands out a refresh token the first time you consent.",
    );
  }
  return { refreshToken: json.refresh_token, accessToken: json.access_token };
}

/** Runs the loopback flow: listens on a free local port, opens for you to visit, waits for the redirect. */
export function runSetup(creds: { clientId: string; clientSecret: string }, fetchImpl: typeof fetch = fetch): Promise<{ refreshToken: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" }).end(
        error ? `<p>Google said: ${error}. You can close this tab.</p>` : "<p>Got it — you can close this tab and go back to the terminal.</p>",
      );
      server.close();
      if (error) {
        reject(new Error(`Google refused: ${error}`));
        return;
      }
      if (!code) {
        reject(new Error("No code in the redirect."));
        return;
      }
      const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;
      exchangeCode(creds, code, redirectUri, fetchImpl).then(({ refreshToken }) => resolve({ refreshToken })).catch(reject);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      console.log("Open this URL, sign in with the Google account JARVIS should use, and approve calendar access:\n");
      console.log(authUrl(creds.clientId, redirectUri));
      console.log("\nWaiting for you to finish in the browser…");
    });
  });
}

// Run as a script: node dist/src/setupGoogleCalendar.js --client-id <id> --client-secret <secret>
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arg = (flag: string) => {
    const i = process.argv.indexOf(flag);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const clientId = arg("--client-id");
  const clientSecret = arg("--client-secret");
  if (!clientId || !clientSecret) {
    console.error("Usage: npm run setup:calendar -- --client-id <id> --client-secret <secret>");
    process.exit(1);
  }
  runSetup({ clientId, clientSecret })
    .then(({ refreshToken }) => {
      console.log("\nAdd these to .env, then restart the container:\n");
      console.log(`GOOGLE_CALENDAR_CLIENT_ID=${clientId}`);
      console.log(`GOOGLE_CALENDAR_CLIENT_SECRET=${clientSecret}`);
      console.log(`GOOGLE_CALENDAR_REFRESH_TOKEN=${refreshToken}`);
    })
    .catch((err: Error) => {
      console.error(`Setup failed: ${err.message}`);
      process.exit(1);
    });
}
