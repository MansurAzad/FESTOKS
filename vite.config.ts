// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { VitePWA } from "vite-plugin-pwa";

// On Vercel (VERCEL env is set during its builds) emit Vercel's Build Output API;
// everywhere else keep the default Cloudflare target used by Lovable publishing.
const onVercel = !!process.env["VERCEL"];

export default defineConfig({
  ...(onVercel ? { nitro: { preset: "vercel" } } : {}),
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: [
      // Offline support: generated SW only (never hand-written). Registration is
      // done solely by the guarded wrapper in src/lib/pwa-register.ts.
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: null,
        devOptions: { enabled: false },
        filename: "sw.js",
        // Manifest is a static public/manifest.webmanifest so it is served
        // identically in dev, preview and production.
        manifest: false,
        workbox: {
          globDirectory: onVercel ? ".vercel/output/static" : ".output/public",
          // Only same-origin hashed build assets are precached (CacheFirst).
          globPatterns: ["**/*.{js,css,svg,png,ico,woff2}"],
          runtimeCaching: [
            {
              // HTML navigations: network first, cache fallback when offline; OAuth excluded.
              urlPattern: ({ request, url }: { request: Request; url: URL }) =>
                request.mode === "navigate" && !url.pathname.startsWith("/~oauth"),
              handler: "NetworkFirst",
              options: {
                cacheName: "pages",
                networkTimeoutSeconds: 5,
                expiration: { maxEntries: 50, maxAgeSeconds: 7 * 24 * 60 * 60 },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//,
              handler: "CacheFirst",
              options: { cacheName: "fonts", expiration: { maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 } },
            },
          ],
        },
      }),
    ],
  },
});
