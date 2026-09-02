import pg from "pg";

const { Pool } = pg;
export type { PoolClient } from "pg";

export const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgres://localhost:5432/recovery_agent";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  pool ??= new Pool({ connectionString: DATABASE_URL });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}

/** Runs fn in a transaction, rolling back on any throw. */
export async function withTransaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
