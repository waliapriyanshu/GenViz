import { randomUUID } from "node:crypto";
import "server-only";
import {
  DATA_SCHEMA,
  READER_ROLE,
  appPool,
  ensureDataSchema,
} from "@/lib/data/app-db";
import { type InferredTable, pgTypeFor } from "@/lib/data/csv-infer";
import { quoteIdent } from "@/lib/data/sql-guard";

const MAX_PARAMS = 60_000;

export function newDatasetTableName(): string {
  return `ds_${randomUUID().replace(/-/g, "")}`;
}

/**
 * Creates `genviz_data.<table>` and loads all rows in ONE transaction with
 * batched multi-row INSERTs. Either the whole dataset lands or nothing does.
 */
export async function loadDataset(
  tableName: string,
  table: InferredTable,
): Promise<void> {
  if (!/^ds_[a-f0-9]{32}$/.test(tableName))
    throw new Error("Invalid dataset table name");
  const { readerRole } = await ensureDataSchema();
  const qualified = `${DATA_SCHEMA}.${quoteIdent(tableName)}`;
  const columnSql = table.columns
    .map((c) => `${quoteIdent(c.name)} ${pgTypeFor(c.kind)}`)
    .join(", ");
  const insertColumns = table.columns.map((c) => quoteIdent(c.name)).join(", ");
  const width = table.columns.length;
  const batchSize = Math.max(
    1,
    Math.min(1_000, Math.floor(MAX_PARAMS / width)),
  );

  const client = await appPool().connect();
  let failed = false;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TABLE ${qualified} (${columnSql})`);
    for (let start = 0; start < table.rows.length; start += batchSize) {
      const batch = table.rows.slice(start, start + batchSize);
      const params: unknown[] = [];
      const tuples = batch.map((row) => {
        const placeholders = row.map((value) => {
          params.push(value);
          return `$${params.length}`;
        });
        return `(${placeholders.join(", ")})`;
      });
      await client.query(
        `INSERT INTO ${qualified} (${insertColumns}) VALUES ${tuples.join(", ")}`,
        params,
      );
    }
    if (readerRole)
      await client.query(`GRANT SELECT ON ${qualified} TO ${READER_ROLE}`);
    await client.query(`ANALYZE ${qualified}`).catch(() => undefined);
    await client.query("COMMIT");
  } catch (error) {
    failed = true;
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release(failed);
  }
}

export async function dropDataset(tableName: string): Promise<void> {
  if (!/^ds_[a-f0-9]{32}$/.test(tableName)) return;
  await appPool().query(
    `DROP TABLE IF EXISTS ${DATA_SCHEMA}.${quoteIdent(tableName)}`,
  );
}
