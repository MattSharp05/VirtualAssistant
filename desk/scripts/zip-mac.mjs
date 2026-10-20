/* global process, console, URL */
// Zips release/mac-arm64/JARVIS Desk.app into release/JARVIS-Desk-<version>-arm64-mac.zip for automatic
// updates (JD-74), after `electron-builder --mac dmg` (npm run dist:mac). ditto keeps the ad-hoc
// signature, symlinks and permissions, and the app unpacks with `ditto -x -k` (updateInstaller.ts).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("The update zip is made with ditto, on macOS");
const desk = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(`${desk}package.json`, "utf8"));
const zip = `${desk}release/JARVIS-Desk-${version}-arm64-mac.zip`;
execFileSync("/usr/bin/ditto", [
  "-c",
  "-k",
  "--sequesterRsrc",
  "--keepParent",
  `${desk}release/mac-arm64/JARVIS Desk.app`,
  zip,
]);
console.log(`Wrote ${zip}`);
