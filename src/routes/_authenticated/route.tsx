import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useMe } from "@/lib/me";
import { useT, type Key } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard,
  Menu,
  Package,
  Users,
  PackageOpen,
  HandCoins,
  ShoppingCart,
  Store,
  Settings2,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useBusiness } from "@/lib/business";
import { useOnline, usePendingSyncCount } from "@/lib/offline";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { toast } from "sonner";

// Logo is served from /public so it works on every host (Lovable + Vercel),
// not only on Lovable's asset CDN.
const LOGO_URL = "/firoza-logo.png";

const navIcon: Partial<Record<Key, LucideIcon>> = {
  dashboard: LayoutDashboard,
  products: Package,
  salesmen: Users,
  stockIssue: PackageOpen,
  settlement: HandCoins,
  sales: ShoppingCart,
  retailers: Store,
  supplierDues: HandCoins,
  settings: Settings2,
  userAccess: ShieldCheck,
};

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // Local session read (no network round-trip per navigation); RLS still enforces access server-side.
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw redirect({ to: "/auth" });
  },
  component: Layout,
});

const adminNav: { to: string; k: Key }[] = [
  { to: "/dashboard", k: "dashboard" },
  { to: "/products", k: "products" },
  { to: "/salesmen", k: "salesmen" },
  { to: "/stock-issue", k: "stockIssue" },
  { to: "/settlement", k: "settlement" },
  { to: "/retailers", k: "retailers" },
  { to: "/supplier-dues", k: "supplierDues" },
  { to: "/settings", k: "settings" },
  { to: "/user-access", k: "userAccess" },
];
const salesNav: { to: string; k: Key }[] = [
  { to: "/dashboard", k: "dashboard" },
  { to: "/sales", k: "sales" },
  { to: "/retailers", k: "retailers" },
  { to: "/settlement", k: "settlement" },
  { to: "/settings", k: "settings" },
];

function Layout() {
  const { data: me } = useMe();
  const { t, lang, setLang } = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pending = usePendingSyncCount();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const nav = me?.isAdmin ? adminNav : salesNav;
  async function signOut() {
    if (pending > 0) {
      setConfirmSignOut(true);
      return;
    }
    await completeSignOut();
  }
  async function completeSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      await qc.cancelQueries();
      qc.clear();
      navigate({ to: "/auth", replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSigningOut(false);
      setConfirmSignOut(false);
    }
  }
  return (
    <div className="min-h-screen pb-20 md:pb-0">
      <header className="sticky top-0 z-20 border-b bg-primary text-primary-foreground">
        <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <img
              src={LOGO_URL}
              alt={t("companyName")}
              className="h-10 w-10 shrink-0 rounded-md bg-card object-contain p-0.5 sm:h-12 sm:w-12"
            />
            <div className="min-w-0">
              <div className="break-words font-display text-base font-bold sm:text-lg">
                {t("companyName")}
              </div>
              <div className="break-words text-xs leading-relaxed opacity-90 sm:text-sm">
                {t("appName")}
              </div>
              <div className="hidden text-xs opacity-80 sm:block">
                {t("companyAddress")} · {t("companyPhone")}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <SyncBadge />
            <BusinessSettings />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setLang(lang === "bn" ? "en" : "bn")}
            >
              {lang === "bn" ? "EN" : "বাং"}
            </Button>
            <Button size="sm" variant="secondary" className="px-2" onClick={signOut}>
              {t("signOut")}
            </Button>
          </div>
          <nav className="col-span-2 hidden flex-wrap gap-1 md:flex">
            {nav.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                className="rounded-md px-3 py-1.5 text-sm hover:bg-primary-foreground/10"
                activeProps={{ className: "bg-accent text-accent-foreground" }}
              >
                {t(n.k)}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <Dialog
        open={confirmSignOut}
        onOpenChange={(open) => {
          if (!signingOut) setConfirmSignOut(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("signOutPendingTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("signOutPendingBody")}</p>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={signingOut}
              onClick={() => setConfirmSignOut(false)}
            >
              {t("cancel")}
            </Button>
            <Button disabled={signingOut} onClick={() => void completeSignOut()}>
              {t("signOutAnyway")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <main className="mx-auto min-w-0 max-w-6xl px-3 py-5 sm:px-4">
        {me?.active ? (
          <Outlet />
        ) : me ? (
          <p className="text-destructive">{t("accountDisabled")}</p>
        ) : null}
      </main>
      <MobileNav nav={nav} />
    </div>
  );
}

/**
 * Mobile navigation: a fixed bottom bar with at most 4 items (first three
 * pages + a "More" button) and an auto-hiding side drawer that lists every
 * page. The drawer closes itself as soon as a page is opened.
 */
function MobileNav({ nav }: { nav: { to: string; k: Key }[] }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const currentPath = useRouterState({ select: (r) => r.location.pathname });
  // Auto-hide the drawer whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [currentPath]);
  const bar = nav.slice(0, 3);
  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t bg-card pb-[env(safe-area-inset-bottom)] shadow-sm md:hidden">
        {bar.map((n) => {
          const Icon = navIcon[n.k] ?? LayoutDashboard;
          return (
            <Link
              key={n.to}
              to={n.to}
              className="flex min-w-0 flex-col items-center gap-1 px-0.5 py-3 text-[10px] text-muted-foreground sm:text-xs"
              activeProps={{ className: "font-bold text-primary" }}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className="break-words text-center leading-tight">{t(n.k)}</span>
            </Link>
          );
        })}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-col items-center gap-1 px-0.5 py-3 text-[10px] text-muted-foreground sm:text-xs"
              aria-label={t("menu")}
            >
              <Menu className="h-5 w-5 shrink-0" />
              <span className="break-words text-center leading-tight">{t("more")}</span>
            </button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0">
            <SheetHeader className="border-b p-4">
              <SheetTitle className="flex items-center gap-2">
                <img
                  src={LOGO_URL}
                  alt={t("companyName")}
                  className="h-8 w-8 shrink-0 rounded-md object-contain"
                />
                <span className="min-w-0 truncate text-sm">{t("menu")}</span>
              </SheetTitle>
            </SheetHeader>
            <div className="flex flex-col p-2">
              {nav.map((n) => {
                const Icon = navIcon[n.k] ?? LayoutDashboard;
                return (
                  <Link
                    key={n.to}
                    to={n.to}
                    onClick={() => setOpen(false)}
                    className="flex min-w-0 items-center gap-3 rounded-md px-3 py-2.5 text-sm hover:bg-muted"
                    activeProps={{ className: "bg-accent font-bold text-accent-foreground" }}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 break-words">{t(n.k)}</span>
                  </Link>
                );
              })}
            </div>
          </SheetContent>
        </Sheet>
      </nav>
    </>
  );
}

/** Shows connection status and how many offline entries still need syncing. */
function SyncBadge() {
  const { t } = useT();
  const online = useOnline();
  const pending = usePendingSyncCount();
  if (online && pending === 0) return null;
  return (
    <span
      className={`rounded-full px-2 py-1 text-[10px] font-semibold sm:text-xs ${
        online ? "bg-warning/20 text-foreground" : "bg-destructive/20 text-primary-foreground"
      }`}
    >
      {online ? `${pending} ${t("pendingSync")}` : t("offline") + (pending ? ` · ${pending}` : "")}
    </span>
  );
}

function BusinessSettings() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [business, saveBusiness] = useBusiness();
  const [f, setF] = useState(business);
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        title={t("businessInfo")}
        onClick={() => {
          setF(business);
          setOpen(true);
        }}
      >
        <Settings2 className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("businessInfo")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t("name")}</Label>
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>{t("address")}</Label>
              <Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>{t("phone")}</Label>
              <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            </div>
            <Button
              className="w-full"
              onClick={() => {
                saveBusiness(f);
                setOpen(false);
              }}
            >
              {t("save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
