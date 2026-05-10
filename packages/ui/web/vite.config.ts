import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // The web service mounts the SPA under /ui by default. Building with
  // base: "/ui/" rewrites all asset URLs so they resolve under that path.
  base: "/ui/",
  root: here,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("../dist/static", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        // Stable, hashable filenames so the Hono static handler can serve
        // them with long cache lifetimes.
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    port: 5184,
    proxy: {
      // In dev (`pnpm --filter @render-harness/ui dev:web`), proxy API calls
      // to a harness web service running locally on :8080.
      "/runs": "http://127.0.0.1:8080",
      "/agents": "http://127.0.0.1:8080",
      "/usage": "http://127.0.0.1:8080",
      "/ui/login": "http://127.0.0.1:8080",
      "/ui/logout": "http://127.0.0.1:8080",
    },
  },
});
