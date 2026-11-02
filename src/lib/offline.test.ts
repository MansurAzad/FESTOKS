import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assignLegacyQueueToUser,
  enqueueOp,
  getQueue,
  isNetworkFailure,
  replayQueue,
  runOrQueue,
} from "./offline";
const { insert, rpc, userId, authListener } = vi.hoisted(() => ({
  insert: vi.fn(),
  rpc: vi.fn(),
  userId: { current: "user-1" },
  authListener: {
    current: null as null | ((event: string, session: { user: { id: string } }) => void),
  },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({ insert }),
    rpc,
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { user: { id: userId.current } } },
        error: null,
      })),
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
    rpc.mockReset();
    authListener.current?.("SIGNED_IN", { user: { id: userId.current } });
  });

  it("stores entries in order with timestamps", () => {
    enqueueOp(
      { kind: "deposit", payload: { salesman_id: "s1", amount: 500, note: null } },
      "user-1",
    );
    enqueueOp({ kind: "retailer_payment", payload: { retailer_id: "r1", amount: 200 } }, "user-1");
    const q = getQueue("user-1");
    expect(q).toHaveLength(2);
    expect(q[0]?.op.kind).toBe("deposit");
    expect(q[1]?.op.kind).toBe("retailer_payment");
    expect(q[0]?.createdAt).toBeTruthy();
  });

  it("survives a reload (reads back from local storage)", () => {
    enqueueOp(
      {
        kind: "add_retailer",
        payload: { name: "Test", phone: "", address: "", salesman_id: "s1" },
      },
      "user-1",
    );
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
    expect(isNetworkFailure({ status: 503, message: "service unavailable" }, false)).toBe(true);
    expect(isNetworkFailure({ message: "insufficient stock" }, false)).toBe(false);
    expect(isNetworkFailure({ message: "admin only" }, false)).toBe(false);
    // Anything is treated as network failure when the browser says it is offline.
    expect(isNetworkFailure({ message: "admin only" }, true)).toBe(true);
  });
  it("keeps queued entries separate between signed-in accounts", () => {
    enqueueOp(
      { kind: "deposit", payload: { salesman_id: "s1", amount: 500, note: null } },
      "user-1",
    );
    enqueueOp(
      { kind: "deposit", payload: { salesman_id: "s2", amount: 200, note: null } },
      "user-2",
    );
    expect(
      getQueue("user-1").map(
        (entry) => entry.op.kind === "deposit" && entry.op.payload.salesman_id,
      ),
    ).toEqual(["s1"]);
    expect(
      getQueue("user-2").map(
        (entry) => entry.op.kind === "deposit" && entry.op.payload.salesman_id,
      ),
    ).toEqual(["s2"]);
  });
  it("replays only the active account queue after an account switch", async () => {
    enqueueOp(
      { kind: "deposit", payload: { salesman_id: "s1", amount: 500, note: null } },
      "user-1",
    );
    enqueueOp(
      { kind: "deposit", payload: { salesman_id: "s2", amount: 200, note: null } },
      "user-2",
    );
    rpc.mockResolvedValue({ data: null, error: null });

    authListener.current?.("SIGNED_IN", { user: { id: "user-2" } });
    const result = await replayQueue();

    expect(result).toMatchObject({ synced: 1, failed: null });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      _payload: { salesman_id: "s2", amount: 200 },
    });
    expect(getQueue("user-1")).toHaveLength(1);
    expect(getQueue("user-2")).toHaveLength(0);
  });
  it("only assigns pre-upgrade entries after an explicit account choice", () => {
    window.localStorage.setItem(
      "offline-queue-v1",
      JSON.stringify([
        {
          id: "legacy-1",
          createdAt: new Date().toISOString(),
          op: { kind: "deposit", payload: { salesman_id: "s1", amount: 10, note: null } },
        },
      ]),
    );
    expect(getQueue("user-2")).toHaveLength(1);
    expect(assignLegacyQueueToUser("user-2")).toBe(1);
    expect(window.localStorage.getItem("offline-queue-v1")).toBeNull();
    expect(getQueue("user-1")).toHaveLength(0);
    expect(getQueue("user-2")).toHaveLength(1);
  });
  it("reuses the online request ID when a network failure queues the operation", async () => {
    const op = { kind: "record_sale" as const, payload: { _retailer: "r1", _items: [], _paid: 0 } };
    rpc.mockResolvedValueOnce({ data: null, error: { message: "Failed to fetch" } });
    const result = await runOrQueue(op, false);
    expect(result.s).toBe("queued");
    const operationId = getQueue("user-1")[0]?.id;
    expect(operationId).toBeTruthy();
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      _operation_id: operationId,
      _kind: "record_sale",
    });
    rpc.mockResolvedValueOnce({ data: { id: "sale-1" }, error: null });
    const replay = await replayQueue();
    expect(replay).toMatchObject({ synced: 1, failed: null });
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({
      _operation_id: operationId,
      _kind: "record_sale",
    });
    expect(getQueue("user-1")).toHaveLength(0);
  });
  it("queues the same operation after an ambiguous server response or fetch rejection", async () => {
    const op = {
      kind: "deposit" as const,
      payload: { salesman_id: "s1", amount: 500, note: null },
    };
    rpc.mockResolvedValueOnce({
      data: null,
      error: { status: 503, message: "service unavailable" },
    });
    const serviceError = await runOrQueue(op, false);
    expect(serviceError.s).toBe("queued");
    const serviceErrorId = getQueue("user-1")[0]?.id;

    rpc.mockRejectedValueOnce(new TypeError("fetch failed"));
    const fetchError = await runOrQueue(op, false);
    expect(fetchError.s).toBe("queued");
    expect(getQueue("user-1").map((entry) => entry.id)).toHaveLength(2);
    expect(rpc.mock.calls[0]?.[1]._operation_id).toBe(serviceErrorId);
    expect(rpc.mock.calls[1]?.[1]._operation_id).toBe(getQueue("user-1")[1]?.id);
  });
  it("manual sync and reconnect share one replay and retain entries queued during replay", async () => {
    let finish: ((value: { error: null }) => void) | undefined;
    rpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    enqueueOp(
      { kind: "deposit", payload: { salesman_id: "s1", amount: 500, note: null } },
      "user-1",
    );
    const first = replayQueue();
    const second = replayQueue();
    enqueueOp(
      { kind: "deposit", payload: { salesman_id: "s1", amount: 200, note: null } },
      "user-1",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rpc).toHaveBeenCalled();
    if (!finish) throw new Error("Replay did not start");
    finish({ error: null });
    await Promise.all([first, second]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(getQueue("user-1")).toHaveLength(1);
    expect(getQueue("user-1")[0]?.op.payload).toEqual({
      salesman_id: "s1",
      amount: 200,
      note: null,
    });
  });
});
