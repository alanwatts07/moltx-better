import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Please configure your Neon database connection string."
    );
  }
  const sql = neon(url);
  return drizzle(sql as any, { schema });
}

// Lazy singleton - only connects when first accessed at runtime
let _db: ReturnType<typeof createDb> | null = null;

export function getDb() {
  if (!_db) {
    _db = createDb();
  }
  return _db;
}

// For convenience - will throw at import time if DATABASE_URL is missing during runtime
// This is intentional for API routes that need the db
export const db = new Proxy({} as ReturnType<typeof createDb>, {
  get(_target, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export type DB = ReturnType<typeof createDb>;
