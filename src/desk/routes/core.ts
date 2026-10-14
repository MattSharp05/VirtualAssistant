// The Desk API's own routes: health, who am I, the live event stream, and answers to server→Mac requests.
import { PROTOCOL_VERSION, type HealthResponse, type MeResponse, type RpcAnswer } from "@jarvis/shared";
import { DeskHttpError, type DeskRoute } from "./index.js";

const routes: DeskRoute[] = [
  {
    method: "GET",
    path: "/health",
    public: true,
    handler: (): HealthResponse => ({ ok: true, protocol: PROTOCOL_VERSION }),
  },
  {
    method: "GET",
    path: "/me",
    handler: ({ device }): MeResponse => ({ id: device!.id, name: device!.name }),
  },
  {
    method: "GET",
    path: "/events",
    handler: ({ req, res, ctx }) => {
      ctx.hub.handle(req, res);
      return undefined;
    },
  },
  {
    method: "POST",
    path: "/rpc/:id",
    handler: ({ params, body, ctx }) => {
      const answer: RpcAnswer = body.ok === true ? { ok: true, result: body.result } : { ok: false, error: String(body.error ?? "failed") };
      if (!ctx.rpc.answer(params.id, answer)) throw new DeskHttpError(404, "no such request (answered or timed out)");
      return { ok: true };
    },
  },
];

export default routes;
