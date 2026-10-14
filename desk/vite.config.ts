import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const shared = fileURLToPath(new URL("../shared/src/protocol.ts", import.meta.url));

export default defineConfig({
  root: "renderer",
  // Relative asset paths so the same build works inside Electron (file://) and on a web host.
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@jarvis/shared": shared } },
  build: { outDir: "dist", emptyOutDir: true },
});
