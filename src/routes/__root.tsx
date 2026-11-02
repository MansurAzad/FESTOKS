import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { Toaster, toast } from "sonner";
import { LangProvider, useT } from "@/lib/i18n";
import { supabase } from "@/integrations/supabase/client";
import { persistQueryClient } from "@tanstack/react-query-persist-client";
import { createAppPersister, hasCachedData, shouldPersistQuery, CACHE_BUSTER } from "@/lib/query-persist";
import { registerAppSW } from "@/lib/pwa-register";
import { replayQueue, useOnline } from "@/lib/offline";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "প্রোডাক্ট ডিস্ট্রিবিউশন ম্যানেজমেন্ট | FIROZA ENTERPRISE" },
      { name: "description", content: "FIROZA ENTERPRISE — KONABARI, GAZIPUR. MOBILE- 01817122232. Product distribution and accounts." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "theme-color", content: "#1f6f78" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { name: "apple-mobile-web-app-title", content: "FIROZA ENT." },
          ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&family=Space+Grotesk:wght@500;700&display=swap" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="bn">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();
  const online = useOnline();
  // First-open validation: without internet and without any locally saved
  // data there is nothing to show, so block with a clear message.
  const [firstOpenBlocked, setFirstOpenBlocked] = useState(false);

  useEffect(() => {
    void registerAppSW();
  }, []);

  useEffect(() => {
    const persister = createAppPersister();
    if (!persister) return;
    const [unsubscribe] = persistQueryClient({
      // Bun's isolated installs give react-query and persist-client separate
      // physical query-core copies; the QueryClient types are identical at runtime.
      queryClient: queryClient as never,
      persister,
      buster: CACHE_BUSTER,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
    });
    return () => {
      unsubscribe();
    };
  }, [queryClient]);

  useEffect(() => {
    setFirstOpenBlocked(!online && !hasCachedData());
  }, [online]);

  useEffect(() => {
    if (!online) return;
    // Connection is back: push any entries saved while offline.
    void replayQueue().then(({ synced, failed }) => {
      if (synced > 0) {
        toast.success(`Offline: ${synced} ✓`);
        queryClient.invalidateQueries();
      }
      if (failed) toast.error(failed);
    });
  }, [online, queryClient]);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
      if (event === "SIGNED_OUT") queryClient.clear();
      else queryClient.invalidateQueries();
    });
    return () => data.subscription.unsubscribe();
  }, [router, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <LangProvider>
        <Outlet />
        {firstOpenBlocked && <FirstOpenOfflineGate />}
        <Toaster richColors position="top-center" />
      </LangProvider>
    </QueryClientProvider>
  );
}

function FirstOpenOfflineGate() {
  const { t } = useT();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background px-6">
      <div className="max-w-sm text-center">
        <h1 className="font-display text-xl font-bold text-foreground">{t("offlineFirstTitle")}</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t("offlineFirstBody")}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-6 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          {t("retry")}
        </button>
      </div>
    </div>
  );
}
