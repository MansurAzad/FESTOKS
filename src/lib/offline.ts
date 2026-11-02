import { useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";

/**
 * Offline entry queue. Entries made without internet are stored locally and
 * replayed against the same database functions when the connection returns.
 * The database functions remain the only writers of stock/sale data — queued
 * entries are validated by them at sync time, never applied optimistically.
 */

export type QueuedOp =
  | { kind: "record_sale"; payload: { _retailer: string; _items: Json[]; _paid: number } }
  | { kind: "return_stock"; payload: { _salesman: string; _items: Json[] } }
  | { kind: "issue_stock"; payload: { _salesman: string; _items: Json[] } }
  | { kind: "deposit"; payload: { salesman_id: string; amount: number; note: string | null } }
  | { kind: "retailer_payment"; payload: { retailer_id: string; amount: number } }
  | {
      kind: "add_retailer";
      payload: { name: string; phone: string; address: string; salesman_id: string };
    };

export type QueueEntry = { id: string; createdAt: string; op: QueuedOp };

const QUEUE_KEY = "offline-queue-v1";
const listeners = new Set<() => void>();
let activeUserId: string | null = null;

if (typeof window !== "undefined") {
  supabase.auth.onAuthStateChange((_event, session) => {
    activeUserId = session?.user.id ?? null;
    emit();
  });
  void supabase.auth.getSession().then(({ data, error }) => {
    if (!error) {
      activeUserId = data.session?.user.id ?? null;
      emit();
    }
  });
}

function emit() {
  for (const l of listeners) l();
}

function readQueue(key: string): QueueEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as QueueEntry[]) : [];
  } catch {
    return [];
  }
}

function userQueueKey(userId: string) {
  return `${QUEUE_KEY}:${userId}`;
}

function createOperationId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("Secure random IDs are unavailable; this entry was not saved.");
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getLegacyQueue() {
  return readQueue(QUEUE_KEY);
}

export function getLegacyQueueCount() {
  return getLegacyQueue().length;
}

export function assignLegacyQueueToUser(userId: string): number {
  if (!userId) throw new Error("Sign in before assigning older offline entries");
  const legacy = getLegacyQueue();
  if (!legacy.length) return 0;
  const existing = readQueue(userQueueKey(userId));
  const reassigned = legacy.map((entry) => ({
    ...entry,
    id: createOperationId(),
  }));
  saveQueue(userId, [...existing, ...reassigned]);
  window.localStorage.removeItem(QUEUE_KEY);
  emit();
  return legacy.length;
}

export function getQueue(userId = activeUserId): QueueEntry[] {
  return [...getLegacyQueue(), ...(userId ? readQueue(userQueueKey(userId)) : [])];
}

function saveQueue(userId: string, entries: QueueEntry[]) {
  window.localStorage.setItem(userQueueKey(userId), JSON.stringify(entries));
  emit();
}

export function enqueueOp(
  op: QueuedOp,
  userId = activeUserId,
  operationId = createOperationId(),
): QueueEntry {
  if (!userId) throw new Error("Sign in before saving an offline entry");
  const entry: QueueEntry = {
    id: operationId,
    createdAt: new Date().toISOString(),
    op,
  };
  saveQueue(userId, [...readQueue(userQueueKey(userId)), entry]);
  return entry;
}

/** True when a failure came from the network being unavailable, not from a server-side rejection. */
export function isNetworkFailure(error: unknown, offline: boolean): boolean {
  if (offline) return true;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 500) return true;
  const msg = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("fetch failed") ||
    msg.includes("network request failed")
  );
}

/** Run one queued op against the same RPC/insert paths the online forms use. */
async function runOp(op: QueuedOp, operationId: string) {
  const result = await supabase.rpc("perform_business_operation", {
    _operation_id: operationId,
    _kind: op.kind,
    _payload: op.payload,
  });
  if (result.error) return result;
  const data = result.data as { id?: string } | null;
  return { ...result, data: op.kind === "record_sale" ? data?.id : result.data };
}

/**
 * Execute a mutation; when the network is down, store it in the queue instead.
 * Returns "done" | "queued" | { error } so callers can toast accordingly.
 */
export type RunResult =
  { s: "done"; data: unknown } | { s: "queued" } | { s: "error"; error: string };

export async function runOrQueue(op: QueuedOp, offline: boolean): Promise<RunResult> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { s: "error", error: sessionError.message };
  const userId = sessionData.session?.user.id;
  if (!userId) return { s: "error", error: "Sign in before saving this entry" };
  let operationId: string;
  try {
    operationId = createOperationId();
  } catch (error) {
    return { s: "error", error: (error as Error).message };
  }

  if (!offline) {
    try {
      const { data, error } = await runOp(op, operationId);
      if (!error) return { s: "done", data };
      if (!isNetworkFailure(error, false)) {
        return { s: "error", error: error.message };
      }
    } catch (error) {
      if (!isNetworkFailure(error, false)) {
        return { s: "error", error: (error as Error).message };
      }
    }
  }
  try {
    enqueueOp(op, userId, operationId);
  } catch (error) {
    return { s: "error", error: (error as Error).message };
  }
  return { s: "queued" };
}

/** Replay every queued entry in order; stop at the first server rejection so order is preserved. */
const replayInFlight = new Map<string, Promise<{ synced: number; failed: string | null }>>();
export function replayQueue(): Promise<{ synced: number; failed: string | null }> {
  if (activeUserId) return replayQueueForUser(activeUserId);
  return supabase.auth.getSession().then(({ data, error }) => {
    if (error) return { synced: 0, failed: error.message };
    const userId = data.session?.user.id;
    return userId ? replayQueueForUser(userId) : { synced: 0, failed: null };
  });
}
function replayQueueForUser(userId: string): Promise<{ synced: number; failed: string | null }> {
  if (getLegacyQueueCount()) {
    return Promise.resolve({
      synced: 0,
      failed:
        "Older offline entries have no account owner and were not replayed. Review them before syncing.",
    });
  }
  let task = replayInFlight.get(userId);
  if (!task) {
    task = replayQueueOnce(userId).finally(() => replayInFlight.delete(userId));
    replayInFlight.set(userId, task);
  }
  return task;
}
async function replayQueueOnce(userId: string): Promise<{ synced: number; failed: string | null }> {
  const entries = readQueue(userQueueKey(userId));
  let synced = 0;
  for (const entry of entries) {
    const { error } = await runOp(entry.op, entry.id);
    if (error) {
      const completed = new Set(entries.slice(0, synced).map((e) => e.id));
      saveQueue(
        userId,
        readQueue(userQueueKey(userId)).filter((e) => !completed.has(e.id)),
      );
      return { synced, failed: error.message };
    }
    synced += 1;
  }
  const completed = new Set(entries.map((e) => e.id));
  saveQueue(
    userId,
    readQueue(userQueueKey(userId)).filter((e) => !completed.has(e.id)),
  );
  return { synced, failed: null };
}

/** Reactive pending-entry count for the header badge. */
export function usePendingSyncCount(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => getQueue().length,
    () => 0,
  );
}

/** Reactive browser online/offline status. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => (typeof navigator === "undefined" ? true : navigator.onLine),
    () => true,
  );
}
