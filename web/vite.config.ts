import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ["wagmi", "viem"],
  },
  optimizeDeps: {
    include: ["wagmi", "wagmi/connectors"],
  },
  server: {
    port: 5173,
    fs: {
      allow: [path.resolve(__dirname, "..")],
    },
    proxy: {
      "/api": {
        target: "http://localhost:3002",
        changeOrigin: true,
        // Return a clean JSON error instead of a raw 500 when the AI server is down.
        configure: (proxy) => {
          proxy.on("error", (_err, _req, res) => {
            if ("writeHead" in res && !res.headersSent) {
              res.writeHead(503, { "Content-Type": "application/json" });
            }
            res.end(
              JSON.stringify({
                error: "AI server is not running. Start it with `npm run dev:all`.",
              })
            );
          });
        },
      },
    },
  },
});
