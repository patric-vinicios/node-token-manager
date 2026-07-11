import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TokenRegistry } from "../../src/registry/tokenRegistry";

function ids(n: number): string[] {
  return Array.from({ length: n }, () => randomUUID());
}

describe("TokenRegistry", () => {
  it("initializes all tokens as available", () => {
    const registry = new TokenRegistry();
    registry.init(ids(100));
    expect(registry.size).toBe(100);
    expect(registry.available).toBe(100);
    expect(registry.active).toBe(0);
  });

  it("keeps available + active equal to the pool size", () => {
    const registry = new TokenRegistry();
    const tokenIds = ids(100);
    registry.init(tokenIds);

    registry.activate(tokenIds[0]!, {
      userId: randomUUID(),
      activatedAt: new Date(),
      activatedAtMonotonic: 0,
    });

    expect(registry.active).toBe(1);
    expect(registry.available).toBe(99);
    expect(registry.available + registry.active).toBe(100);
  });

  it("release is idempotent (releasing an available token is a no-op)", () => {
    const registry = new TokenRegistry();
    const tokenIds = ids(3);
    registry.init(tokenIds);

    expect(registry.release(tokenIds[0]!)).toBeNull();
    expect(registry.active).toBe(0);
    expect(registry.available).toBe(3);
  });

  it("activate then release restores availability", () => {
    const registry = new TokenRegistry();
    const [id] = ids(1);
    registry.init([id!]);
    registry.activate(id!, {
      userId: randomUUID(),
      activatedAt: new Date(),
      activatedAtMonotonic: 1,
    });
    expect(registry.getState(id!)).toBe("active");
    const prev = registry.release(id!);
    expect(prev).not.toBeNull();
    expect(registry.getState(id!)).toBe("available");
  });

  it("rejects duplicate ids at init", () => {
    const registry = new TokenRegistry();
    const dup = randomUUID();
    expect(() => registry.init([dup, dup])).toThrow(/Duplicate/);
  });

  it("throws when activating an unknown or already-active token", () => {
    const registry = new TokenRegistry();
    const [id] = ids(1);
    registry.init([id!]);
    const info = {
      userId: randomUUID(),
      activatedAt: new Date(),
      activatedAtMonotonic: 0,
    };
    expect(() => registry.activate(randomUUID(), info)).toThrow(/Unknown/);
    registry.activate(id!, info);
    expect(() => registry.activate(id!, info)).toThrow(/already active/);
  });

  it("re-init resets to all-available", () => {
    const registry = new TokenRegistry();
    const first = ids(2);
    registry.init(first);
    registry.activate(first[0]!, {
      userId: randomUUID(),
      activatedAt: new Date(),
      activatedAtMonotonic: 0,
    });
    const second = ids(4);
    registry.init(second);
    expect(registry.size).toBe(4);
    expect(registry.active).toBe(0);
    expect(registry.tokenIds()).toEqual(second);
  });
});
