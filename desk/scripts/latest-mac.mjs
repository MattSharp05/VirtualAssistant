/* global process, URL, console */
// Writes release/latest-mac.json for automatic updates (JD-74): the version, the zip's download URL on
// the desk-v<version> release, its size and sha256. release.yml runs it after `npm run dist:mac`;
// the app reads it (desk/main/updateInstaller.ts → parseManifest). Usage: node scripts/latest-mac.mjs <version>
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error(`Not a release version: ${version}`);
const dir = new URL("../release/", import.meta.url).pathname;
const zips = readdirSync(dir).filter((f) => f.endsWith(".zip"));
if (zips.length !== 1) throw new Error(`Expected one .zip in release/, found ${zips.length}`);
const name = zips[0];
const file = join(dir, name);
const manifest = {
  version,
  url: `https://github.com/MattSharp05/VirtualAssistant/releases/download/desk-v${version}/${encodeURIComponent(name)}`,
  size: statSync(file).size,
  sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
};
writeFileSync(join(dir, "latest-mac.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
