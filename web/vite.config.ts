import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Coach Board on the web: an installable, offline app (Safari > Share > Add to Home Screen).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon-192.png", "icon-512.png", "apple-touch-icon.png"],
      manifest: {
        name: "Coach Board",
        short_name: "Coach Board",
        description: "Volleyball coaching board: live match, tactics in 2D and 3D, and video to 3D with eye views.",
        display: "standalone",
        orientation: "any",
        background_color: "#F3F5F8",
        theme_color: "#0F1B2D",
        start_url: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,json,wasm,task,woff2}"],
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
      },
    }),
  ],
  test: { globals: true, environment: "node", passWithNoTests: true },
});
