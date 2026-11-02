# Deploying to Vercel

1. Push this repository to GitHub and import it in Vercel (Framework preset: **Other** — `vercel.json` already sets install/build commands).
2. In Vercel → Project → Settings → Environment Variables, add (Production + Preview):
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`
   - `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`
   - `LOVABLE_API_KEY` (needed for the AI dealer-risk ranking)
   - `SUPABASE_SERVICE_ROLE_KEY` (required to create salesman accounts from the app; never expose this key in browser variables)
3. Deploy. The build detects `VERCEL`, uses Nitro's `vercel` preset, and copies the VitePWA-generated service worker and Workbox runtime into Vercel's static output. The default Cloudflare build also copies these generated PWA files into `.output/public`.
4. Add your Vercel domain to the backend auth redirect URLs so sign-up confirmation emails return to it.

After deployment, verify `/sw.js` and `/manifest.webmanifest` return successfully, install the app on a test device, and confirm a previously opened page and pending offline entries behave as expected without a network connection.
