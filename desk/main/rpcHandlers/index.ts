// The Mac's side of server→Mac requests (src/desk/rpc.ts): an `rpc` event on the live stream names a
// kind; its handler's result (or refusal) goes back with POST /api/desk/rpc/:id. A kind is a key in
// the handler map, so a ticket adding one (clipboard, screenshot) adds a module and a key.
import type { DeskEvent, RpcAnswer } from "@jarvis/shared";

export type RpcHandler = (payload: unknown) => Promise<unknown>;
export type RpcEvent = Extract<DeskEvent, { type: "rpc" }>;

/** Runs the handler for `event.kind` and sends its answer; never throws (a failed answer is logged). */
export async function answerRpc(
  event: RpcEvent,
  handlers: Record<string, RpcHandler>,
  send: (path: string, answer: RpcAnswer) => Promise<unknown>,
): Promise<RpcAnswer> {
  const handler = Object.hasOwn(handlers, event.kind) ? handlers[event.kind] : undefined;
  let answer: RpcAnswer;
  if (!handler) answer = { ok: false, error: `This Desk can't do ${event.kind} yet.` };
  else {
    try {
      answer = { ok: true, result: await handler(event.payload) };
    } catch (err) {
      answer = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  try {
    await send(`/rpc/${encodeURIComponent(event.id)}`, answer);
  } catch (err) {
    // Another Desk answered first, or the server gave up waiting; nothing more to do.
    console.warn(`rpc ${event.kind} answer not delivered:`, err instanceof Error ? err.message : err);
  }
  return answer;
}
