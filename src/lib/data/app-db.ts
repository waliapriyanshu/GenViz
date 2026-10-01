import pg from "pg";
import "server-only";
import { genvizTypes } from "@/lib/data/pg-types";
import { ConfigError } from "@/lib/errors";

/**
 * Raw `pg` pool for Genviz's own database. Used for uploaded datasets (bulk
 * load + guarded read-only queries). Prisma handles the metadata tables.
 */
const globalForPool = globalThis as unknown as {
  genvizPool?: pg.Pool;
  genvizDataSchema?: Promise<DataSchemaState>;
};

export const DATA_SCHEMA = "genviz_data";
export const READER_ROLE = "genviz_reader";

export function appPool(): pg.Pool {
  if (!globalForPool.genvizPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new ConfigError("DATABASE_URL is not set.");
    globalForPool.genvizPool = new pg.Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      types: genvizTypes,
      application_name: "genviz",
    });
    globalForPool.genvizPool.on("error", (error) =>
      console.error("[genviz] idle pg client error", error),
    );
  }
  return globalForPool.genvizPool;
}

export interface DataSchemaState {
  /** true when queries can run as the SELECT-only `genviz_reader` role */
  readerRole: boolean;
}

/**
 * Idempotently creates the dataset schema and a NOLOGIN, SELECT-only role that
 * the executor switches to (SET LOCAL ROLE) while running model-written SQL.
 * If the database user may not create roles, queries still run inside READ ONLY
 * transactions, and the Query Guard still enforces the table allowlist.
 */
export function ensureDataSchema(): Promise<DataSchemaState> {
  globalForPool.genvizDataSchema ??= (async () => {
    const client = await appPool().connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${DATA_SCHEMA}`);
      let readerRole = false;
      try {
        await client.query(`
          DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${READER_ROLE}') THEN
              CREATE ROLE ${READER_ROLE} NOLOGIN;
            END IF;
          END $$;`);
        await client.query(
          `GRANT USAGE ON SCHEMA ${DATA_SCHEMA} TO ${READER_ROLE}`,
        );
        await client.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${DATA_SCHEMA} GRANT SELECT ON TABLES TO ${READER_ROLE}`,
        );
        await client
          .query(`GRANT ${READER_ROLE} TO CURRENT_USER`)
          .catch(() => undefined);
        const membership = await client.query<{ ok: boolean }>(
          `SELECT pg_has_role(current_user, '${READER_ROLE}', 'MEMBER') AS ok`,
        );
        readerRole = membership.rows[0]?.ok === true;
      } catch (error) {
        console.warn(
          `[genviz] could not set up the ${READER_ROLE} role; dataset queries will rely on READ ONLY transactions only.`,
          error instanceof Error ? error.message : error,
        );
      }
      return { readerRole };
    } finally {
      client.release();
    }
  })().catch((error) => {
    globalForPool.genvizDataSchema = undefined;
    throw error;
  });
  return globalForPool.genvizDataSchema;
}
