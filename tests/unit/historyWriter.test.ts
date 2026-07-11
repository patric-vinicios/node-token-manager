import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createHistoryWriter } from "../../src/services/historyWriter";
import type { Database } from "../../src/db/client";
import type { Logger } from "../../src/lib/logger";

/**
 * Minimal in-memory stand-in for the Drizzle `Database` surface used by the
 * writer: `insert().values()` (non-eviction path) and `transaction()` wrapping
 * `update().set().where()` + `insert().values()` (eviction path). A configurable
 * failure counter exercises the retry/flush paths without a real Postgres.
 */
class FakeDb {
  readonly inserts: Array<{ values: Record<string, unknown> }> = [];
  readonly updates: Array<{ set: Record<string, unknown> }> = [];
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
        return Promise.resolve();
      },
    };
  }

  async transaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    // A whole transaction fails atomically: nothing is recorded on failure.
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
        return Promise.resolve();
      },
    };
  }
  update(_table: unknown) {
    return {
      set: (s: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          this.db.updates.push({ set: s });
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

describe("historyWriter", () => {
  it("opens a new row on assignment (no eviction)", async () => {
    const fake = new FakeDb();
    const writer = createHistoryWriter({ db: asDb(fake), logger: mockLogger() });
    const tokenId = randomUUID();
    const userId = randomUUID();
    const startedAt = new Date();

    await writer.record({ tokenId, userId, startedAt, evicted: false });

    expect(fake.txCount).toBe(0);
    expect(fake.updates).toHaveLength(0);
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0]!.values).toMatchObject({ tokenId, userId, startedAt });
    await writer.stop();
  });

  it("closes the prior open row on eviction, inside one transaction", async () => {
    const fake = new FakeDb();
    const writer = createHistoryWriter({ db: asDb(fake), logger: mockLogger() });
    const tokenId = randomUUID();
    const userId = randomUUID();
    const startedAt = new Date();

    await writer.record({ tokenId, userId, startedAt, evicted: true });

    expect(fake.txCount).toBe(1);
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]!.set).toMatchObject({
      releaseReason: "eviction",
      releasedAt: startedAt,
    });
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0]!.values).toMatchObject({ tokenId, userId, startedAt });
    await writer.stop();
  });

  it("never throws on a db failure and logs the buffering", async () => {
    const fake = new FakeDb();
    fake.failuresRemaining = 1;
    const logger = mockLogger();
    const writer = createHistoryWriter({
      db: asDb(fake),
      logger,
      options: { baseBackoffMs: 60_000 }, // keep the auto-retry from firing during the test
    });

    await expect(
      writer.record({
        tokenId: randomUUID(),
        userId: randomUUID(),
        startedAt: new Date(),
        evicted: false,
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledOnce();
    expect(fake.inserts).toHaveLength(0); // failed write persisted nothing
    await writer.stop();
  });

  it("retries a buffered event with backoff until it succeeds", async () => {
    const fake = new FakeDb();
    fake.failuresRemaining = 1; // first attempt fails, retry succeeds
    const writer = createHistoryWriter({
      db: asDb(fake),
      logger: mockLogger(),
      options: { baseBackoffMs: 5, maxBackoffMs: 20 },
    });

    await writer.record({
      tokenId: randomUUID(),
      userId: randomUUID(),
      startedAt: new Date(),
      evicted: false,
    });

    await vi.waitFor(() => expect(fake.inserts).toHaveLength(1));
    await writer.stop();
  });

  it("flush drains buffered events on shutdown", async () => {
    const fake = new FakeDb();
    fake.failuresRemaining = 1; // initial write fails → event is buffered
    const writer = createHistoryWriter({
      db: asDb(fake),
      logger: mockLogger(),
      options: { baseBackoffMs: 60_000 }, // ensure flush (not the timer) drains it
    });

    await writer.record({
      tokenId: randomUUID(),
      userId: randomUUID(),
      startedAt: new Date(),
      evicted: false,
    });
    expect(fake.inserts).toHaveLength(0);

    await writer.flush();
    expect(fake.inserts).toHaveLength(1);
    await writer.stop();
  });
});
