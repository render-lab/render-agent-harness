import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // The wizard SPA is served at the service root, not under /ui.
  base: "/",
  root: here,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("../dist/static", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    port: 5185,
    proxy: {
      // In dev (`pnpm --filter @render-harness/wizard dev:web`), proxy API
      // calls to a wizard server running locally on :8090.
      "/api": "http://127.0.0.1:8090",
      "/healthz": "http://127.0.0.1:8090",
    },
  },
});
