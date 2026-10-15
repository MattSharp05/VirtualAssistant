// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { jpegName, multipart, Uploader, UPLOAD_CHUNK, type UploaderOptions } from "./uploads";

const URL_ = "https://jarvis.tail1234.ts.net:8443";
const KEY = "jd_test_key_aaaaaaaaaaaaaaaaaaaa";
const MB = 1024 * 1024;

/** A fake server for POST /api/desk/files: reads the multipart body like the real route does. */
function fakeServer(answer?: (file: File) => Response) {
  const got: { file: File; headers: Record<string, string> }[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`${URL_}/api/desk/files`);
    const headers = init?.headers as Record<string, string>;
    const form = await new Request("http://desk/files", {
      method: "POST",
      headers: { "content-type": headers["content-type"]! },
      body: init?.body,
      duplex: "half",
    } as RequestInit).formData();
    const file = form.get("file") as File;
    got.push({ file, headers });
    return (
      answer?.(file) ??
      new Response(
        JSON.stringify({ id: "u1", path: `/data/jarvis/uploads/u1/${file.name}`, name: file.name }),
        {
          status: 200,
        },
      )
    );
  });
  return { fetch: fetchFn as unknown as typeof fetch, got, fetchFn };
}

function uploader(over: Partial<UploaderOptions> = {}) {
  return new Uploader({ config: () => ({ serverUrl: URL_, deviceKey: KEY }), ...over });
}

describe("Uploader", () => {
  it("posts a dropped file from disk as multipart with the device key, with progress up to 1", async () => {
    const server = fakeServer();
    const bytes = new Uint8Array(UPLOAD_CHUNK * 2 + 10).fill(7);
    bytes[UPLOAD_CHUNK] = 1;
    const progress: number[] = [];
    const up = uploader({
      fetch: server.fetch,
      size: async () => bytes.length,
      readFile: async (p) => (expect(p).toBe("/Users/m/Desktop/Q3 report.pdf"), bytes),
    });
    const answer = await up.upload({ path: "/Users/m/Desktop/Q3 report.pdf", name: "Q3 report.pdf" }, (f) =>
      progress.push(f),
    );
    expect(answer).toEqual({
      id: "u1",
      path: "/data/jarvis/uploads/u1/Q3 report.pdf",
      name: "Q3 report.pdf",
    });
    const { file, headers } = server.got[0]!;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(file.name).toBe("Q3 report.pdf");
    expect(file.type).toBe("application/pdf");
    expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress.slice(1, -1).every((f) => f > 0 && f < 1)).toBe(true);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it("sends bytes when the file has no path (an image dragged out of a page)", async () => {
    const server = fakeServer();
    await uploader({ fetch: server.fetch }).upload({
      name: "notes.md",
      bytes: new TextEncoder().encode("# hi"),
    });
    expect(await server.got[0]!.file.text()).toBe("# hi");
    expect(server.got[0]!.file.type).toBe("text/markdown");
  });

  it("turns HEIC into JPEG before it goes", async () => {
    const server = fakeServer();
    const toJpeg = vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff]));
    const answer = await uploader({ fetch: server.fetch, size: async () => 3 * MB, toJpeg }).upload({
      path: "/Users/m/Pictures/IMG_0042.HEIC",
      name: "IMG_0042.HEIC",
    });
    expect(toJpeg).toHaveBeenCalledWith("/Users/m/Pictures/IMG_0042.HEIC");
    expect(server.got[0]!.file.name).toBe("IMG_0042.jpg");
    expect(server.got[0]!.file.type).toBe("image/jpeg");
    expect(answer.name).toBe("IMG_0042.jpg");
  });

  it("turns away files over 20 MB and types JARVIS can't read, without uploading", async () => {
    const server = fakeServer();
    const up = uploader({ fetch: server.fetch, size: async () => 25 * MB, readFile: vi.fn() });
    await expect(up.upload({ path: "/tmp/big.pdf", name: "big.pdf" })).rejects.toThrow(
      "big.pdf is 25 MB: files can be up to 20 MB.",
    );
    await expect(
      uploader({ fetch: server.fetch }).upload({ name: "a.zip", bytes: new Uint8Array(4) }),
    ).rejects.toThrow(/can't read \.zip files/);
    expect(server.fetchFn).not.toHaveBeenCalled();
  });

  it("passes on the server's error and needs a connection", async () => {
    const server = fakeServer(
      () => new Response(JSON.stringify({ error: "Files can be up to 20 MB." }), { status: 413 }),
    );
    await expect(
      uploader({ fetch: server.fetch }).upload({ name: "a.txt", bytes: new Uint8Array(1) }),
    ).rejects.toThrow("Files can be up to 20 MB.");
    await expect(
      new Uploader({ config: () => ({ serverUrl: "" }) }).upload({ name: "a.txt", bytes: new Uint8Array(1) }),
    ).rejects.toThrow(/Not connected/);
  });
});

describe("multipart", () => {
  it("keeps the file name from breaking the header and counts its length", () => {
    const { parts, length, boundary } = multipart('a"b\r\n.txt', "text/plain", new Uint8Array(3), "B");
    const text = new TextDecoder().decode(parts[0]);
    expect(boundary).toBe("B");
    expect(text).toContain('filename="a_b__.txt"');
    expect(length).toBe(parts.reduce((n, p) => n + p.length, 0));
  });

  it("names converted HEICs .jpg", () => {
    expect(jpegName("IMG_1.HEIC")).toBe("IMG_1.jpg");
    expect(jpegName("photo.heic")).toBe("photo.jpg");
  });
});
