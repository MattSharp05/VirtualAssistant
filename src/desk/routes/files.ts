// POST /api/desk/files (multipart/form-data, field "file", ≤ 20 MB) → { id, path, name }.
// The Desk then sends the id with its chat message (POST /api/desk/chat { attachments: [id] }).
import { Readable } from "node:stream";
import { JarvisError } from "../../jarvis.js";
import { MAX_UPLOAD_BYTES, UploadStore, UploadTooLarge, type Upload } from "../../uploads.js";
import { DeskHttpError, type DeskRoute } from "./index.js";

const route: DeskRoute = {
  method: "POST",
  path: "/files",
  rawBody: true,
  handler: async ({ req, ctx }): Promise<Upload> => {
    const length = Number(req.headers["content-length"] ?? 0);
    if (length > MAX_UPLOAD_BYTES + 64 * 1024) throw new DeskHttpError(413, `Files can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    if (!String(req.headers["content-type"] ?? "").startsWith("multipart/form-data")) throw new DeskHttpError(400, "Send multipart/form-data with a file field.");
    let form: FormData;
    try {
      form = await new Request("http://desk/files", {
        method: "POST",
        headers: { "content-type": String(req.headers["content-type"]) },
        body: Readable.toWeb(req) as ReadableStream,
        duplex: "half",
      } as RequestInit).formData();
    } catch {
      throw new DeskHttpError(400, "Couldn't read the upload.");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new DeskHttpError(400, "No file field in the upload.");
    try {
      return new UploadStore(ctx.jarvis.config.dataDir).save(file.name, new Uint8Array(await file.arrayBuffer()));
    } catch (err) {
      if (err instanceof UploadTooLarge) throw new DeskHttpError(413, err.message);
      if (err instanceof JarvisError) throw new DeskHttpError(400, err.message);
      throw err;
    }
  },
};

export default route;
