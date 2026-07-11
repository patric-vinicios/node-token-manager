import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";

const BASE_ENV = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
} satisfies NodeJS.ProcessEnv;

describe("config", () => {
  it("applies default values when only DATABASE_URL is set", () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.POOL_SIZE).toBe(100);
    expect(config.TOKEN_TTL_SECONDS).toBe(120);
    expect(config.PORT).toBe(3000);
    expect(config.API_BASE_PATH).toBe("/api");
    expect(config.DATABASE_URL).toBe(BASE_ENV.DATABASE_URL);
  });

  it("overrides defaults from the environment", () => {
    const config = loadConfig({
      ...BASE_ENV,
      PORT: "8080",
      POOL_SIZE: "50",
      TOKEN_TTL_SECONDS: "30",
      API_BASE_PATH: "v1/tokens",
    });
    expect(config.PORT).toBe(8080);
    expect(config.POOL_SIZE).toBe(50);
    expect(config.TOKEN_TTL_SECONDS).toBe(30);
    // Base path is normalized to a leading slash, no trailing slash.
    expect(config.API_BASE_PATH).toBe("/v1/tokens");
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("rejects an out-of-range PORT", () => {
    expect(() => loadConfig({ ...BASE_ENV, PORT: "99999" })).toThrow(
      /Invalid configuration/,
    );
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadConfig({ ...BASE_ENV, PORT: "abc" })).toThrow(
      /Invalid configuration/,
    );
  });

  it("rejects a non-positive POOL_SIZE", () => {
    expect(() => loadConfig({ ...BASE_ENV, POOL_SIZE: "0" })).toThrow(
      /Invalid configuration/,
    );
  });

  it("returns a frozen config object", () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(Object.isFrozen(config)).toBe(true);
  });
});
