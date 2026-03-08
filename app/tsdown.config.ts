import { defineConfig } from "tsdown";
import { copyFileSync } from "node:fs";

export default defineConfig([
  {
    entry: { main: "src/main/main.ts" },
    outDir: "dist/main/main",
    format: "cjs",
    platform: "node",
    target: "node22",
    // Keep Electron built-ins and native addons external — they must not be bundled.
    deps: {
      neverBundle: [
        "electron",
        "better-sqlite3",
        "keytar",
        "cloudflared",
        "ws",
        "express",
        "private-connect",
        "electron-updater",
      ],
    },
    sourcemap: true,
    clean: false,
  },
  {
    entry: { preload: "src/main/preload.ts" },
    outDir: "dist/main/main",
    format: "cjs",
    platform: "node",
    target: "node22",
    deps: {
      neverBundle: ["electron"],
    },
    sourcemap: true,
    clean: false,
    hooks: {
      // Electron's createWindow() loads "preload.js" by convention, but tsdown
      // emits "preload.cjs". Keep preload.js in sync after every build.
      "build:done": () => {
        copyFileSync("dist/main/main/preload.cjs", "dist/main/main/preload.js");
      },
    },
  },
  {
    entry: { aiWorker: "src/main/aiWorker.ts" },
    outDir: "dist/main/main",
    format: "cjs",
    platform: "node",
    target: "node22",
    deps: {
      neverBundle: ["electron"],
    },
    sourcemap: true,
    clean: false,
  },
]);
