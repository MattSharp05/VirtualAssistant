import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { mediapipeAssets } from "./resources/mediapipe/assets";

const shared = fileURLToPath(new URL("../shared/src/protocol.ts", import.meta.url));

// `vite build --mode web` is the browser preview (Vercel): it adds dev.html (every scenario × window)
// and writes to renderer/dist-web. The plain build is what Electron loads.
export default defineConfig(({ mode }) => ({
  root: "renderer",
  // Relative asset paths so the same build works inside Electron (file://) and on a web host.
  base: "./",
  // Camera hands' WASM + model go next to index.html (JD-42); the app's build can't do without them.
  plugins: [react(), mediapipeAssets({ required: mode !== "web" })],
  resolve: { alias: { "@jarvis/shared": shared } },
  build: {
    outDir: mode === "web" ? "dist-web" : "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./renderer/index.html", import.meta.url)),
        ...(mode === "web" ? { dev: fileURLToPath(new URL("./renderer/dev.html", import.meta.url)) } : {}),
      },
    },
  },
}));
