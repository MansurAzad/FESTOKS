# FIROZA ENTERPRISE — Product Distribution Management

মোবাইল ফোনের স্টক, সেলসম্যানকে পণ্য বিতরণ, রিটেইলার বিক্রি, বাকি আদায়, পণ্য ফেরত এবং নগদ জমার হিসাব রাখার ওয়েব অ্যাপ।

## মূল সুবিধা

- Owner ও salesman account; database RLS এবং audited permission changes
- Smartphone-এর IMEI-ভিত্তিক stock issue, sale ও return; button phone-এর quantity tracking
- Retailer ledger, sales receipt, payment collection এবং salesman settlement
- Dashboard, low-stock/overdue alerts, CSV export ও print/PDF reports
- বাংলা ও English UI; installable PWA এবং সীমিত offline entry queue
- Owner-only business backup/restore ও audited history correction

## চালানো

প্রয়োজন: Node.js 22+ এবং Bun (lockfile অনুযায়ী)।

```sh
bun install --frozen-lockfile
bun run dev
```

পরীক্ষা ও production build:

```sh
bun run test
bun run lint
bunx tsc --noEmit
bun run build
```

Vercel-এর জন্য `bun run build:vercel` ব্যবহার হয়; এই build generated PWA service worker ও Workbox runtime Vercel static output-এ কপি করে।

## Backend ও environment

অ্যাপটি Supabase Auth/PostgreSQL এবং `drizzle/migrations/`-এর SQL migration ব্যবহার করে। `supabase/config.toml`-এ project configuration আছে। প্রয়োজনীয় server/client environment variables deployment অনুযায়ী Vercel setup-এ দেখুন: [DEPLOY-VERCEL.md](./DEPLOY-VERCEL.md)।

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — server-only; app থেকে salesman account তৈরির জন্য প্রয়োজন
- `LOVABLE_API_KEY` — owner-requested AI dealer-risk assessment-এর জন্য
- `SUPABASE_DB_MIGRATION_URL` — server-only PostgreSQL session-pooler URL; কখনো `VITE_` prefix দেবেন না

কোনো secret `VITE_` variable-এ রাখবেন না। `.env` বা credential কখনো commit করবেন না। Production database migration চালানোর আগে আলাদা backup এবং অনুমোদিত migration process নিশ্চিত করুন।

## Database migrations

`drizzle/migrations/` is the canonical SQL migration source. Before deploying, mirror its journaled migrations into Supabase CLI's timestamped migration directory and apply them to the linked project:

```sh
supabase login
supabase link --project-ref <project-ref>
bun run db:push
```

`db:push` applies each migration transactionally through the authenticated Supabase CLI SQL interface and records its version in Supabase migration history. It does not update Vault secrets. Review the project ref before running it against production.

## Offline ও data safety

প্রথমবার অ্যাপ খোলার সময় internet প্রয়োজন। Offline-এ তৈরি entry local device-এ থাকে এবং পরে database validation-এর মধ্য দিয়ে sync হয়; pending entry হারানো এড়াতে account sign-out বা device পরিবর্তনের আগে sync সম্পন্ন করুন। Business backup পূর্ণ database/account/storage backup নয়; সম্পূর্ণ backup-এর জন্য backend provider-এর export ব্যবহার করুন।

## প্রযুক্তি

React, TypeScript, TanStack Start/Router/Query, Supabase, PostgreSQL, Vite, Vitest এবং VitePWA।
