import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TokenRegistry, type ActiveInfo } from "../../src/registry/tokenRegistry";
import { createListingService } from "../../src/services/listingService";

function ids(n: number): string[] {
  return Array.from({ length: n }, () => randomUUID());
}

/** Build an ActiveInfo with an explicit monotonic value for deterministic timing. */
function info(monotonic: number, userId = randomUUID()): ActiveInfo {
  return { userId, activatedAt: new Date(), activatedAtMonotonic: monotonic };
}

const TTL = 120;

describe("createListingService", () => {
  it("lists all tokens with correct state", () => {
    const registry = new TokenRegistry();
    const tokenIds = ids(5);
    registry.init(tokenIds);
    // Activate two of the five.
    registry.activate(tokenIds[0]!, info(0));
    registry.activate(tokenIds[2]!, info(0));

    const service = createListingService({ registry, ttlSeconds: TTL, now: () => 0 });
    const { tokens } = service.list();

    expect(tokens).toHaveLength(tokenIds.length);
    for (const entry of tokens) {
      expect(entry.state).toBe(registry.getState(entry.tokenId));
    }
    expect(new Set(tokens.map((t) => t.tokenId))).toEqual(new Set(tokenIds));
  });

  it("includes userId, activatedAt, remainingSeconds only for active tokens", () => {
    const registry = new TokenRegistry();
    const tokenIds = ids(2);
    registry.init(tokenIds);
    const userId = randomUUID();
    registry.activate(tokenIds[0]!, info(0, userId));

    const service = createListingService({ registry, ttlSeconds: TTL, now: () => 0 });
    const { tokens } = service.list();

    const active = tokens.find((t) => t.tokenId === tokenIds[0])!;
    const available = tokens.find((t) => t.tokenId === tokenIds[1])!;

    expect(active.state).toBe("active");
    expect(active.userId).toBe(userId);
    expect(active.activatedAt).toBe(registry.getActiveInfo(tokenIds[0]!)!.activatedAt.toISOString());
    expect(active.remainingSeconds).toBe(TTL);

    expect(available.state).toBe("available");
    expect(available.userId).toBeUndefined();
    expect(available.activatedAt).toBeUndefined();
    expect(available.remainingSeconds).toBeUndefined();
  });

  it("computes remainingSeconds from ttlSeconds and elapsed monotonic time", () => {
    const registry = new TokenRegistry();
    const tokenIds = ids(1);
    registry.init(tokenIds);
    // Activated at monotonic 1000ms; "now" is 31_000ms → 30s elapsed.
    registry.activate(tokenIds[0]!, info(1000));

    const service = createListingService({ registry, ttlSeconds: TTL, now: () => 31_000 });
    const { tokens } = service.list();

    expect(tokens[0]!.remainingSeconds).toBe(TTL - 30);
  });

  it("floors remainingSeconds to whole seconds", () => {
    const registry = new TokenRegistry();
    const tokenIds = ids(1);
    registry.init(tokenIds);
    registry.activate(tokenIds[0]!, info(0));

    // 10.7s elapsed → remaining 109.3 → floored to 109 (never overstates).
    const service = createListingService({ registry, ttlSeconds: TTL, now: () => 10_700 });
    const { tokens } = service.list();

    expect(tokens[0]!.remainingSeconds).toBe(109);
  });

  it("clamps remainingSeconds at zero past TTL", () => {
    const registry = new TokenRegistry();
    const tokenIds = ids(1);
    registry.init(tokenIds);
    registry.activate(tokenIds[0]!, info(0));

    // Elapsed 200s > 120s TTL → clamped to 0, never negative.
    const service = createListingService({ registry, ttlSeconds: TTL, now: () => 200_000 });
    const { tokens } = service.list();

    expect(tokens[0]!.remainingSeconds).toBe(0);
  });

  it("summary counts sum to pool size", () => {
    const registry = new TokenRegistry();
    const tokenIds = ids(100);
    registry.init(tokenIds);
    for (let i = 0; i < 37; i++) registry.activate(tokenIds[i]!, info(0));

    const service = createListingService({ registry, ttlSeconds: TTL, now: () => 0 });
    const { summary } = service.list();

    expect(summary.active).toBe(registry.active);
    expect(summary.available).toBe(registry.available);
    expect(summary.available + summary.active).toBe(registry.size);
  });

  it("returns an empty-active summary for a freshly initialized pool", () => {
    const registry = new TokenRegistry();
    const size = 100;
    registry.init(ids(size));

    const service = createListingService({ registry, ttlSeconds: TTL, now: () => 0 });
    const { tokens, summary } = service.list();

    expect(summary).toEqual({ available: size, active: 0 });
    expect(tokens.every((t) => t.userId === undefined)).toBe(true);
    expect(tokens.every((t) => t.activatedAt === undefined)).toBe(true);
    expect(tokens.every((t) => t.remainingSeconds === undefined)).toBe(true);
  });
});
