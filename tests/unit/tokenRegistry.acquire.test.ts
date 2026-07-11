import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TokenRegistry, type ActiveInfo } from "../../src/registry/tokenRegistry";

function ids(n: number): string[] {
  return Array.from({ length: n }, () => randomUUID());
}

/** Build an ActiveInfo with an explicit monotonic value for deterministic ordering. */
function info(monotonic: number, userId = randomUUID()): ActiveInfo {
  return { userId, activatedAt: new Date(), activatedAtMonotonic: monotonic };
}

describe("TokenRegistry.acquire", () => {
  it("assigns an available token", () => {
    const registry = new TokenRegistry();
    registry.init(ids(100));

    const result = registry.acquire(info(1));

    expect(registry.has(result.tokenId)).toBe(true);
    expect(registry.getState(result.tokenId)).toBe("active");
    expect(registry.active).toBe(1);
    expect(result.evicted).toBeNull();
  });

  it("transitions available to active and stores the holder info", () => {
    const registry = new TokenRegistry();
    registry.init(ids(10));
    const holder = info(42, randomUUID());

    const { tokenId } = registry.acquire(holder);

    expect(registry.getState(tokenId)).toBe("active");
    const stored = registry.getActiveInfo(tokenId);
    expect(stored?.userId).toBe(holder.userId);
    expect(stored?.activatedAtMonotonic).toBe(42);
    expect(stored?.activatedAt).toBe(holder.activatedAt);
  });

  it("evicts the oldest active token when the pool is full", () => {
    const registry = new TokenRegistry();
    const tokenIds = ids(100);
    registry.init(tokenIds);

    // Fill all 100 with strictly increasing monotonic times.
    tokenIds.forEach((_, i) => registry.acquire(info(i + 1)));
    expect(registry.active).toBe(100);
    expect(registry.available).toBe(0);

    const oldestTokenId = tokenIds[0]!; // acquired first → smallest monotonic
    const newHolder = info(1000, randomUUID());
    const result = registry.acquire(newHolder);

    expect(result.evicted).not.toBeNull();
    expect(result.evicted!.tokenId).toBe(oldestTokenId);
    // The evicted token is reused in place for the new holder.
    expect(result.tokenId).toBe(oldestTokenId);
    expect(registry.getActiveInfo(oldestTokenId)?.userId).toBe(newHolder.userId);
    expect(registry.active).toBe(100);
  });

  it("never exceeds the pool size across many acquires", () => {
    const registry = new TokenRegistry();
    registry.init(ids(100));

    for (let i = 0; i < 500; i++) {
      registry.acquire(info(i + 1));
      expect(registry.active).toBeLessThanOrEqual(100);
      expect(registry.available + registry.active).toBe(100);
    }
    expect(registry.active).toBe(100);
  });

  it("breaks exact monotonic ties by seed order", () => {
    const registry = new TokenRegistry();
    const [a, b] = ids(2);
    registry.init([a!, b!]);

    // Two active tokens with the SAME monotonic value.
    registry.acquire(info(5)); // → a (first available)
    registry.acquire(info(5)); // → b
    expect(registry.active).toBe(2);

    const result = registry.acquire(info(9, randomUUID()));
    // Earlier-seeded token (a) is evicted on the tie.
    expect(result.evicted!.tokenId).toBe(a);
    expect(result.tokenId).toBe(a);
  });
});
