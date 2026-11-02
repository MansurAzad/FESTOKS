/**
 * Service worker registration wrapper. The app-shell SW (/sw.js) must never
 * register in dev, iframe, or Lovable preview contexts — it would keep
 * serving stale previews. In refused contexts any matching SW is unregistered.
 */

function isLovablePreviewHost(hostname: string): boolean {
  const previewLabel = /^(?:id-preview|preview)(?:-[a-z0-9]+)?--.+$/;
  for (const suffix of [".lovable.app", ".gpt-eng.com", ".gptengineer.run"]) {
    if (hostname.endsWith(suffix)) {
      const first = hostname.slice(0, -suffix.length).split(".")[0] ?? "";
      if (previewLabel.test(first)) return true;
    }
  }
  const projectDev = /^project--[a-z0-9-]+-dev$/;
  for (const suffix of [".lovable.app", ".gpt-eng.com", ".gptengineer.run"]) {
    if (hostname.endsWith(suffix) && projectDev.test(hostname.slice(0, -suffix.length))) return true;
  }
  return (
    hostname === "lovableproject.com" ||
    hostname.endsWith(".lovableproject.com") ||
    hostname === "lovableproject-dev.com" ||
    hostname.endsWith(".lovableproject-dev.com") ||
    hostname === "beta.lovable.dev" ||
    hostname.endsWith(".beta.lovable.dev")
  );
}

function isRefusedContext(): boolean {
  if (!import.meta.env.PROD) return true;
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return true;
  if (window.self !== window.top) return true;
  if (isLovablePreviewHost(window.location.hostname.toLowerCase())) return true;
  if (new URLSearchParams(window.location.search).get("sw") === "off") return true;
  return false;
}

async function unregisterAppSWs() {
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    regs
      .filter((r) => r.active?.scriptURL.endsWith("/sw.js") || r.waiting?.scriptURL.endsWith("/sw.js") || r.installing?.scriptURL.endsWith("/sw.js"))
      .map((r) => r.unregister()),
  );
}

export async function registerAppSW() {
  if (isRefusedContext()) {
    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      await unregisterAppSWs().catch(() => undefined);
    }
    return;
  }
  const { registerSW } = await import("virtual:pwa-register");
  registerSW({ immediate: true });
}
