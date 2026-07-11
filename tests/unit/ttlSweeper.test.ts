import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTtlSweeper } from "../../src/services/ttlSweeper";
import { TokenRegistry } from "../../src/registry/tokenRegistry";
import type { HistoryWriter } from "../../src/services/historyWriter";
import type { Logger } from "../../src/lib/logger";

const TTL_SECONDS = 120;
const TTL_MS = TTL_SECONDS * 1000;

function mockLogger(): Logger & { error: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & { error: ReturnType<typeof vi.fn> };
}

/** Fake writer double so unit tests never touch a real DB. */
function fakeHistoryWriter(): HistoryWriter & {
  closeCalls: Array<{ tokenId: string; reason: string }>;
} {
  const closeCalls: Array<{ tokenId: string; reason: string }> = [];
  return {
    closeCalls,
    record: vi.fn(async () => undefined),
    close: vi.fn(async (input) => {
      closeCalls.push({ tokenId: input.tokenId, reason: input.reason });
    }),
    flush: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

function seedActiveToken(registry: TokenRegistry, ageMs: number): string {
  const tokenId = randomUUID();
  registry.init([tokenId]);
  registry.activate(tokenId, {
    userId: randomUUID(),
    activatedAt: new Date(Date.now() - ageMs),
    activatedAtMonotonic: performance.now() - ageMs,
  });
  return tokenId;
}

describe("ttlSweeper", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("releases a token whose monotonic age has reached the TTL", async () => {
    const registry = new TokenRegistry();
    const tokenId = seedActiveToken(registry, TTL_MS + 5000);
    const historyWriter = fakeHistoryWriter();
    const sweeper = createTtlSweeper({
      registry,
      historyWriter,
      ttlSeconds: TTL_SECONDS,
      logger: mockLogger(),
    });

    await sweeper.sweepOnce();

    expect(registry.getState(tokenId)).toBe("available");
    expect(historyWriter.close).toHaveBeenCalledOnce();
    expect(historyWriter.closeCalls[0]).toMatchObject({ tokenId, reason: "ttl" });
  });

  it("leaves tokens under the TTL threshold active", async () => {
    const registry = new TokenRegistry();
    const tokenId = seedActiveToken(registry, 1000);
    const historyWriter = fakeHistoryWriter();
    const sweeper = createTtlSweeper({
      registry,
      historyWriter,
      ttlSeconds: TTL_SECONDS,
      logger: mockLogger(),
    });

    await sweeper.sweepOnce();

    expect(registry.getState(tokenId)).toBe("active");
    expect(historyWriter.close).not.toHaveBeenCalled();
  });

  it("releases a token exactly at the 120s threshold using activatedAtMonotonic (F02↔F03)", async () => {
    const registry = new TokenRegistry();
    const tokenId = seedActiveToken(registry, TTL_MS);
    const historyWriter = fakeHistoryWriter();
    const sweeper = createTtlSweeper({
      registry,
      historyWriter,
      ttlSeconds: TTL_SECONDS,
      logger: mockLogger(),
    });

    await sweeper.sweepOnce();

    expect(registry.getState(tokenId)).toBe("available");
  });

  it("ignores wall-clock changes and measures elapsed time via monotonic time", async () => {
    vi.useFakeTimers();
    const registry = new TokenRegistry();
    // Real monotonic elapsed stays under the TTL even though we jump the wall clock.
    const tokenId = seedActiveToken(registry, 1000);
    vi.setSystemTime(Date.now() + 1000 * 60 * 60 * 6); // +6 hours wall-clock jump

    const historyWriter = fakeHistoryWriter();
    const sweeper = createTtlSweeper({
      registry,
      historyWriter,
      ttlSeconds: TTL_SECONDS,
      logger: mockLogger(),
    });

    await sweeper.sweepOnce();

    expect(registry.getState(tokenId)).toBe("active");
    expect(historyWriter.close).not.toHaveBeenCalled();
  });

  it("is idempotent when release races with another release path", async () => {
    const tokenId = randomUUID();
    const activatedAtMonotonic = performance.now() - (TTL_MS + 5000);
    const fakeRegistry = {
      snapshot: () => [
        {
          tokenId,
          state: "active" as const,
          active: { userId: randomUUID(), activatedAt: new Date(), activatedAtMonotonic },
        },
      ],
      release: vi.fn(() => null), // simulates an eviction/clear that already released it
    };
    const historyWriter = fakeHistoryWriter();
    const sweeper = createTtlSweeper({
      registry: fakeRegistry as unknown as TokenRegistry,
      historyWriter,
      ttlSeconds: TTL_SECONDS,
      logger: mockLogger(),
    });

    await expect(sweeper.sweepOnce()).resolves.toBeUndefined();
    expect(historyWriter.close).not.toHaveBeenCalled();
  });

  it("isolates a single tick's failure without stopping the sweeper", async () => {
    const registry = new TokenRegistry();
    const tokenId = seedActiveToken(registry, TTL_MS + 5000);
    const logger = mockLogger();
    const historyWriter = fakeHistoryWriter();
    (historyWriter.close as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db unavailable"),
    );
    const sweeper = createTtlSweeper({
      registry,
      historyWriter,
      ttlSeconds: TTL_SECONDS,
      logger,
    });

    await expect(sweeper.sweepOnce()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    // The token was still released in-memory even though the history close rejected.
    expect(registry.getState(tokenId)).toBe("available");

    // A subsequent tick still works correctly for a newly-due token.
    const secondTokenId = randomUUID();
    registry.init([secondTokenId]);
    registry.activate(secondTokenId, {
      userId: randomUUID(),
      activatedAt: new Date(),
      activatedAtMonotonic: performance.now() - (TTL_MS + 5000),
    });
    await sweeper.sweepOnce();
    expect(registry.getState(secondTokenId)).toBe("available");
  });

  it("start() schedules recurring sweeps and stop() halts them", async () => {
    const registry = new TokenRegistry();
    const tokenId = seedActiveToken(registry, TTL_MS + 5000);
    const historyWriter = fakeHistoryWriter();
    const sweeper = createTtlSweeper({
      registry,
      historyWriter,
      ttlSeconds: TTL_SECONDS,
      logger: mockLogger(),
      intervalMs: 20,
    });

    sweeper.start();
    await vi.waitFor(() => expect(registry.getState(tokenId)).toBe("available"));
    await sweeper.stop();

    const newTokenId = randomUUID();
    registry.init([newTokenId]);
    registry.activate(newTokenId, {
      userId: randomUUID(),
      activatedAt: new Date(),
      activatedAtMonotonic: performance.now() - (TTL_MS + 5000),
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(registry.getState(newTokenId)).toBe("active"); // no further ticks after stop()
  });

  it("sweep timer is unref'd so it never keeps the process alive", () => {
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(global, "setInterval")
      .mockImplementation(((..._args: unknown[]) => {
        return { unref, ref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval);

    const registry = new TokenRegistry();
    registry.init([]);
    const sweeper = createTtlSweeper({
      registry,
      historyWriter: fakeHistoryWriter(),
      ttlSeconds: TTL_SECONDS,
      logger: mockLogger(),
    });

    sweeper.start();

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
  });
});
