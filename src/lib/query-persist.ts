import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

/**
 * Last-fetched business data (products, retailers, summaries, dashboard) is
 * kept in local storage so the app can show it without internet. Security
 * decisions (the "me" role query, dealer risk) are never persisted.
 */
export const CACHE_BUSTER = "v1";
export const CACHE_KEY = "rq-cache-v1";

export function createAppPersister() {
  if (typeof window === "undefined") return null;
  return createSyncStoragePersister({
    storage: window.localStorage,
    key: CACHE_KEY,
    throttleTime: 1000,
  });
}

export function shouldPersistQuery(query: { state: { status: string }; queryKey: readonly unknown[] }): boolean {
  if (query.state.status !== "success") return false;
  const key = String(query.queryKey[0] ?? "");
  return key !== "me" && !key.includes("risk") && !key.startsWith("user-access");
}

/** True when this browser has never cached app data (used by the first-open offline gate). */
export function hasCachedData(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(CACHE_KEY) !== null;
}
