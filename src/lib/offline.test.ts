import { beforeEach, describe, expect, it, vi } from "vitest";
import { assignLegacyQueueToUser, enqueueOp, getQueue, isNetworkFailure, replayQueue } from "./offline";
const { insert, userId, authListener } = vi.hoisted(() => ({
  insert: vi.fn(),
  userId: { current: "user-1" },
  authListener: { current: null as null | ((event: string, session: { user: { id: string } }) => void) },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({ insert }),
    rpc: vi.fn(),
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { user: { id: userId.current } } }, error: null })),
      onAuthStateChange: vi.fn((callback: typeof authListener.current) => {
        authListener.current = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
    },
  },
}));

describe("offline queue", () => {
  beforeEach(() => {
    window.localStorage.clear();
    insert.mockReset();
    authListener.current?.("SIGNED_IN", { user: { id: userId.current } });
  });

  it("stores entries in order with timestamps", () => {
    enqueueOp({ kind: "deposit", payload: { salesman_id: "s1", amount: 500, note: null } }, "user-1");
    enqueueOp({ kind: "retailer_payment", payload: { retailer_id: "r1", amount: 200 } }, "user-1");
    const q = getQueue("user-1");
    expect(q).toHaveLength(2);
    expect(q[0]?.op.kind).toBe("deposit");
    expect(q[1]?.op.kind).toBe("retailer_payment");
    expect(q[0]?.createdAt).toBeTruthy();
  });

  it("survives a reload (reads back from local storage)", () => {
    enqueueOp({ kind: "add_retailer", payload: { name: "Test", phone: "", address: "", salesman_id: "s1" } }, "user-1");
    // Simulate a fresh page load: module state is irrelevant, storage is the source.
    const raw = window.localStorage.getItem("offline-queue-v1:user-1");
    expect(raw).toBeTruthy();
    if (!raw) throw new Error("Queue was not saved");
    const parsed = JSON.parse(raw);
    expect(parsed[0].op.payload.name).toBe("Test");
  });

  it("detects network failures, not server rejections", () => {
    expect(isNetworkFailure(new Error("Failed to fetch"), false)).toBe(true);
    expect(isNetworkFailure({ message: "Network request failed" }, false)).toBe(true);
    expect(isNetworkFailure({ message: "insufficient stock" }, false)).toBe(false);
    expect(isNetworkFailure({ message: "admin only" }, false)).toBe(false);
    // Anything is treated as network failure when the browser says it is offline.
    expect(isNetworkFailure({ message: "admin only" }, true)).toBe(true);
  });
  it("keeps queued entries separate between signed-in accounts", () => {
    enqueueOp({ kind: "deposit", payload: { salesman_id: "s1", amount: 500, note: null } }, "user-1");
    enqueueOp({ kind: "deposit", payload: { salesman_id: "s2", amount: 200, note: null } }, "user-2");
    expect(getQueue("user-1").map((entry) => entry.op.kind === "deposit" && entry.op.payload.salesman_id)).toEqual(["s1"]);
    expect(getQueue("user-2").map((entry) => entry.op.kind === "deposit" && entry.op.payload.salesman_id)).toEqual(["s2"]);
  });
  it("only assigns pre-upgrade entries after an explicit account choice", () => {
    window.localStorage.setItem("offline-queue-v1", JSON.stringify([
      { id: "legacy-1", createdAt: new Date().toISOString(), op: { kind: "deposit", payload: { salesman_id: "s1", amount: 10, note: null } } },
    ]));
    expect(getQueue("user-2")).toHaveLength(1);
    expect(assignLegacyQueueToUser("user-2")).toBe(1);
    expect(window.localStorage.getItem("offline-queue-v1")).toBeNull();
    expect(getQueue("user-1")).toHaveLength(0);
    expect(getQueue("user-2")).toHaveLength(1);
  });
  it("manual sync and reconnect share one replay and retain entries queued during replay", async () => {
    let finish: ((value: { error: null }) => void) | undefined;
    insert.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    enqueueOp({ kind: "deposit", payload: { salesman_id: "s1", amount: 500, note: null } }, "user-1");
    const first = replayQueue();
    const second = replayQueue();
    enqueueOp({ kind: "deposit", payload: { salesman_id: "s1", amount: 200, note: null } }, "user-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(insert).toHaveBeenCalled();
    if (!finish) throw new Error("Replay did not start");
    finish({ error: null });
    await Promise.all([first, second]);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(getQueue("user-1")).toHaveLength(1);
    expect(getQueue("user-1")[0]?.op.payload).toEqual({ salesman_id: "s1", amount: 200, note: null });
  });
});
