import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
      },
    }),
    tailwindcss(),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173
  },
  base: "./",
  build: {
    outDir: "dist/renderer"
  }
});
