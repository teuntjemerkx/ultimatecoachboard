import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import type { Connect, Plugin } from "vite";
import { scheduleProxy } from "./api/schedule";

/** `/api/schedule` in the dev and preview servers, as Vercel serves it in production. */
function scheduleService(): Plugin {
  const handle: Connect.NextHandleFunction = (req, res) => {
    void scheduleProxy(`http://localhost${req.originalUrl ?? ""}`).then(async (r) => {
      res.statusCode = r.status;
      r.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await r.text());
    });
  };
  return {
    name: "schedule-service",
    configureServer: (server) => { server.middlewares.use("/api/schedule", handle); },
    configurePreviewServer: (server) => { server.middlewares.use("/api/schedule", handle); },
  };
}

// Coach Board on the web: an installable, offline app (Safari > Share > Add to Home Screen).
export default defineConfig({
  plugins: [
    react(),
    scheduleService(),
    VitePWA({
      // A new version waits until the coach restarts into it (src/app/updates.ts), never mid-match.
      registerType: "prompt",
      manifest: {
        name: "Coach Board",
        short_name: "Coach Board",
        description: "Volleyball coaching board: live match, tactics in 2D and 3D, and video to 3D with eye views.",
        display: "standalone",
        orientation: "any",
        background_color: "#0D0C18",
        theme_color: "#0D0C18",
        start_url: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,json,wasm,task,tflite,woff2,glb}"],
        // MediaPipe (34 MB) is only for Video to 3D: kept when it is first used, not downloaded with the app.
        globIgnores: ["**/vision_wasm_nosimd_internal.*", "tools/**", "mediapipe/**", "models/**"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [{
          urlPattern: ({ url }) => /^\/(mediapipe|models)\//.test(url.pathname),
          handler: "CacheFirst",
          options: { cacheName: "mediapipe-v1", cacheableResponse: { statuses: [200] } },
        }],
      },
    }),
  ],
  test: { globals: true, environment: "node", passWithNoTests: true },
});
