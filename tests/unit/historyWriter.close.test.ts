import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createHistoryWriter } from "../../src/services/historyWriter";
import type { Database } from "../../src/db/client";
import type { Logger } from "../../src/lib/logger";

/**
 * Minimal in-memory stand-in for the Drizzle `Database` surface used by the
 * writer, extended with call-order tracking so ordering between a `close`
 * (UPDATE) and a subsequent `record` (INSERT/transaction) for the same token
 * can be asserted.
 */
class FakeDb {
  readonly inserts: Array<{ values: Record<string, unknown> }> = [];
  readonly updates: Array<{ set: Record<string, unknown> }> = [];
  readonly callOrder: Array<"update" | "insert"> = [];
  txCount = 0;
  failuresRemaining = 0;

  private maybeFail(): void {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("db unavailable");
    }
  }

  insert(_table: unknown) {
    return {
      values: (v: Record<string, unknown>) => {
        this.maybeFail();
        this.inserts.push({ values: v });
        this.callOrder.push("insert");
        return Promise.resolve();
      },
    };
  }

  update(_table: unknown) {
    return {
      set: (s: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          this.maybeFail();
          this.updates.push({ set: s });
          this.callOrder.push("update");
          return Promise.resolve();
        },
      }),
    };
  }

  async transaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    this.maybeFail();
    this.txCount += 1;
    return fn(new FakeTx(this));
  }
}

class FakeTx {
  constructor(private readonly db: FakeDb) {}
  insert(_table: unknown) {
    return {
      values: (v: Record<string, unknown>) => {
        this.db.inserts.push({ values: v });
        this.db.callOrder.push("insert");
        return Promise.resolve();
      },
    };
  }
  update(_table: unknown) {
    return {
      set: (s: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          this.db.updates.push({ set: s });
          this.db.callOrder.push("update");
          return Promise.resolve();
        },
      }),
    };
  }
}

function mockLogger(): Logger & { error: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & { error: ReturnType<typeof vi.fn> };
}

const asDb = (fake: FakeDb) => fake as unknown as Database;

describe("historyWriter.close", () => {
  it("closes an open row with the given release reason", async () => {
    const fake = new FakeDb();
    const writer = createHistoryWriter({ db: asDb(fake), logger: mockLogger() });
    const tokenId = randomUUID();
    const releasedAt = new Date();

    await writer.close({ tokenId, releasedAt, reason: "ttl" });

    expect(fake.txCount).toBe(0);
    expect(fake.inserts).toHaveLength(0);
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]!.set).toMatchObject({ releasedAt, releaseReason: "ttl" });
    await writer.stop();
  });

  it("never throws on a db failure and buffers the close for retry", async () => {
    const fake = new FakeDb();
    fake.failuresRemaining = 1;
    const logger = mockLogger();
    const writer = createHistoryWriter({
      db: asDb(fake),
      logger,
      options: { baseBackoffMs: 5, maxBackoffMs: 20 },
    });
    const tokenId = randomUUID();

    await expect(
      writer.close({ tokenId, releasedAt: new Date(), reason: "ttl" }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledOnce();
    expect(fake.updates).toHaveLength(0);

    await vi.waitFor(() => expect(fake.updates).toHaveLength(1));
    expect(fake.updates[0]!.set).toMatchObject({ releaseReason: "ttl" });
    await writer.stop();
  });

  it("orders a close before a later open for the same token (F02↔F03)", async () => {
    const fake = new FakeDb();
    const writer = createHistoryWriter({ db: asDb(fake), logger: mockLogger() });
    const tokenId = randomUUID();

    const closePromise = writer.close({ tokenId, releasedAt: new Date(), reason: "ttl" });
    const recordPromise = writer.record({
      tokenId,
      userId: randomUUID(),
      startedAt: new Date(),
      evicted: false,
    });

    await Promise.all([closePromise, recordPromise]);

    expect(fake.callOrder).toEqual(["update", "insert"]);
    await writer.stop();
  });
});
