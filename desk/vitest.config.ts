import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const shared = fileURLToPath(new URL("../shared/src/protocol.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@jarvis/shared": shared } },
  test: {
    include: ["{main,preload,renderer}/**/*.test.{ts,tsx}"],
    environment: "jsdom",
  },
});
