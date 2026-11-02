# Deploying to Vercel

1. Push this repository to GitHub and import it in Vercel (Framework preset: **Other** — `vercel.json` already sets install/build commands). Connect the production branch so GitHub pushes trigger production deployments.
2. In Vercel → Project → Settings → Environment Variables, add (Production + Preview):
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`
   - `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`
   - `LOVABLE_API_KEY` (needed for the AI dealer-risk ranking)
   - `SUPABASE_SERVICE_ROLE_KEY` (required in Production and Preview to create salesman accounts from the app; server-only, never use a `VITE_` prefix or expose this key in browser variables)
3. If `SUPABASE_SERVICE_ROLE_KEY` is absent, the app can still build, but owner-managed salesman account creation will fail at runtime. Add the key in Vercel → Project → Settings → Environment Variables, then redeploy. The key must remain server-only.
4. Deploy. The build detects `VERCEL`, uses Nitro's `vercel` preset, and copies the VitePWA-generated service worker and Workbox runtime into Vercel's static output. The default Cloudflare build also copies these generated PWA files into `.output/public`.
5. Add your Vercel domain to the backend auth redirect URLs for password-reset emails.

After deployment, verify `/sw.js` and `/manifest.webmanifest` return successfully, confirm owner-managed account creation, install the app on a test device, and confirm a previously opened page and pending offline entries behave as expected without a network connection.
