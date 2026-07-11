import { defineConfig } from "drizzle-kit";

// drizzle-kit reads DATABASE_URL directly from the environment so that the
// generate/migrate CLI never depends on the app's runtime config module.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/postgres",
  },
  strict: true,
  verbose: true,
});
