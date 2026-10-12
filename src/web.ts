// The dashboard: one page plus a small JSON API, on node:http (no framework needed at this size).
//
//   GET  /                       the dashboard page
//   GET  /api/state              status, plan usage, jobs, reports
//   POST /api/jobs               { task }            start a cloud session
//   POST /api/jobs/:id/messages  { message }         message a session
//   POST /api/reports            { job, text }       a cloud session reporting back (Bearer REPORT_SECRET)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { JarvisError, type Jarvis } from "./jarvis.js";
import { RoutineError } from "./routines.js";

const PAGE = new URL("../../public/index.html", import.meta.url) // dist/src/web.js → <app>/public;
const MAX_BODY = 64 * 1024;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  // Requiring JSON also blocks cross-site form posts: a browser can't send this content type
  // to another origin without a preflight, which this server never approves.
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new JarvisError("Send JSON.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new JarvisError("Request too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new JarvisError("Invalid JSON.");
  }
}

function dashboardAllowed(req: IncomingMessage, password: string | undefined): boolean {
  if (!password) return true;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  return safeEqual(decoded.slice(decoded.indexOf(":") + 1), password);
}

export function createDashboard(jarvis: Jarvis): Server {
  const { config, store } = jarvis;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      // Reports authenticate with their own secret, so a cloud session never needs the dashboard password.
      if (req.method === "POST" && url.pathname === "/api/reports") {
        const secret = config.reportSecret;
        const auth = req.headers.authorization ?? "";
        if (!secret || !safeEqual(auth, `Bearer ${secret}`)) return send(res, 401, { error: "unauthorized" });
        const body = await readJson(req);
        const job = String(body.job ?? "").trim();
        const text = String(body.text ?? "").trim();
        if (!job || !text) return send(res, 400, { error: "job and text are required" });
        return send(res, 201, store.addReport(job, text.slice(0, 8000)));
      }

      if (!dashboardAllowed(req, config.dashboardPassword)) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="JARVIS"' });
        return res.end("JARVIS dashboard: password required");
      }

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(PAGE));
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        return send(res, 200, {
          status: await jarvis.status(),
          currentJobId: store.currentJob()?.id,
          jobs: store.recentJobs(50),
          reports: store.recentReports(100),
        });
      }

      if (req.method === "POST" && url.pathname === "/api/jobs") {
        const body = await readJson(req);
        const result = await jarvis.startJob(String(body.task ?? ""));
        return send(res, 201, result);
      }

      const message = url.pathname.match(/^\/api\/jobs\/([a-z0-9]+)\/messages$/i);
      if (req.method === "POST" && message) {
        const body = await readJson(req);
        return send(res, 201, await jarvis.sendMessage(message[1], String(body.message ?? "")));
      }

      send(res, 404, { error: "not found" });
    } catch (err) {
      const known = err instanceof JarvisError || err instanceof RoutineError;
      if (!known) console.error("dashboard error:", err);
      send(res, known ? 400 : 500, { error: known ? (err as Error).message : "internal error" });
    }
  });
}
