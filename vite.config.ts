import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;
const rootDir = dirname(fileURLToPath(import.meta.url));
const pkgVersion = JSON.parse(
  readFileSync(join(rootDir, "package.json"), "utf8"),
).version as string;

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  define: {
    // Packager bumps package.json before build; About UI reads this.
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
