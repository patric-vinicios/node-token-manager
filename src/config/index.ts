import { z } from "zod";

/**
 * Typed, Zod-validated configuration read once from the environment at startup.
 *
 * Fail-fast: {@link loadConfig} throws a descriptive error if any value is
 * invalid or a required value (DATABASE_URL) is missing, so the service never
 * boots in a misconfigured state (PRD F01 Error Handling).
 */

const DEFAULTS = {
  PORT: 3000,
  API_BASE_PATH: "/api",
  POOL_SIZE: 100,
  TOKEN_TTL_SECONDS: 120,
} as const;

/** Coerce a possibly-undefined env string into an integer, applying a default. */
const intWithDefault = (fallback: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : v))
    .pipe(z.coerce.number().int());

const basePathSchema = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === undefined || v === "" ? DEFAULTS.API_BASE_PATH : v))
  .transform((v) => (v.startsWith("/") ? v : `/${v}`))
  // Normalize a trailing slash away so mounting is predictable ("/api", not "/api/").
  .transform((v) => (v.length > 1 && v.endsWith("/") ? v.replace(/\/+$/, "") : v));

const envSchema = z.object({
  DATABASE_URL: z
    .string({ required_error: "DATABASE_URL is required" })
    .trim()
    .min(1, "DATABASE_URL is required"),
  // 0 is permitted and means "let the OS assign an ephemeral port" (useful in tests).
  PORT: intWithDefault(DEFAULTS.PORT).pipe(
    z.number().int().min(0, "PORT must be between 0 and 65535").max(65535, "PORT must be between 0 and 65535"),
  ),
  API_BASE_PATH: basePathSchema,
  POOL_SIZE: intWithDefault(DEFAULTS.POOL_SIZE).pipe(
    z.number().int().positive("POOL_SIZE must be a positive integer"),
  ),
  TOKEN_TTL_SECONDS: intWithDefault(DEFAULTS.TOKEN_TTL_SECONDS).pipe(
    z.number().int().positive("TOKEN_TTL_SECONDS must be a positive integer"),
  ),
});

export type AppConfig = Readonly<z.infer<typeof envSchema>>;

/**
 * Parse and validate configuration from the given environment (defaults to
 * `process.env`). Throws with a flattened, human-readable message on failure.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return Object.freeze(parsed.data);
}
