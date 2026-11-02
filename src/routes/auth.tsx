import { pageHead } from "@/lib/page-head";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useT } from "@/lib/i18n";
// Logo is served from /public so it works on every host (Lovable + Vercel),
// not only on Lovable's asset CDN.
const LOGO_URL = "/firoza-logo.png";

export const Route = createFileRoute("/auth")({
  head: () =>
    pageHead(
      "লগইন",
      "Sign in to FIROZA ENTERPRISE Product Distribution Management. KONABARI, GAZIPUR. MOBILE- 01817122232.",
    ),
  component: AuthPage,
});

function AuthPage() {
  const { t, lang, setLang } = useT();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"in" | "reset-request" | "reset-password">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (params.get("mode") === "reset-password" || hash.get("type") === "recovery") {
      setMode("reset-password");
    }
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setMode("reset-password");
    });
    return () => subscription.unsubscribe();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate({ to: "/dashboard" });
      } else if (mode === "reset-request") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth?mode=reset-password`,
        });
        if (error) throw error;
        toast.success(t("passwordResetSent"));
        setMode("in");
      } else {
        if (password.length < 12) throw new Error(t("passwordGuidance"));
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        toast.success(t("passwordUpdated"));
        navigate({ to: "/dashboard" });
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-md rounded-lg border-t-4 border-t-primary shadow-sm">
        <CardHeader>
          <div className="mb-3 flex w-full justify-center">
            <img
              src={LOGO_URL}
              alt={t("companyName")}
              className="mx-auto h-28 w-28 rounded-lg object-contain sm:h-32 sm:w-32"
            />
          </div>
          <div className="relative mb-1">
            <Button
              size="sm"
              variant="ghost"
              className="absolute right-0 top-0"
              onClick={() => setLang(lang === "bn" ? "en" : "bn")}
            >
              {lang === "bn" ? "EN" : "বাং"}
            </Button>
            <div className="text-center">
              <div className="break-words font-display text-xl font-bold text-primary sm:text-2xl">
                {t("companyName")}
              </div>
              <CardTitle className="mt-2 break-words text-lg leading-relaxed">
                {t("appName")}
              </CardTitle>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {t("companyAddress")}
                <br />
                {t("companyPhone")}
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1">
              <Label>{t("email")}</Label>
              <Input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            {mode !== "reset-request" && (
              <div className="space-y-1">
                <Label>{t(mode === "reset-password" ? "newPassword" : "password")}</Label>
                <Input
                  type="password"
                  autoComplete={mode === "in" ? "current-password" : "new-password"}
                  required
                  minLength={mode === "reset-password" ? 12 : undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {mode === "reset-password" && (
                  <p className="text-xs text-muted-foreground">{t("passwordGuidance")}</p>
                )}
              </div>
            )}
            <Button className="w-full" disabled={loading}>
              {t(
                mode === "in"
                  ? "signIn"
                  : mode === "reset-request"
                    ? "sendResetLink"
                    : "resetPassword",
              )}
            </Button>
          </form>
          {mode === "in" && (
            <Button
              type="button"
              variant="link"
              className="mt-2 w-full"
              onClick={() => setMode("reset-request")}
            >
              {t("forgotPassword")}
            </Button>
          )}
          {mode !== "in" && (
            <Button
              type="button"
              variant="link"
              className="mt-2 w-full"
              onClick={() => {
                setPassword("");
                setMode("in");
              }}
            >
              {t("signIn")}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
