import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dataDir: string | null = null;
let closeDb: typeof import('@/db/client').closeDb | null = null;

afterEach(() => {
  closeDb?.();
  closeDb = null;
  vi.resetModules();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
  delete process.env.DEV_COCKPIT_DATA_DIR;
});

function columns(dbFile: string, table: string): string[] {
  const sqlite = new Database(dbFile, { readonly: true });
  try {
    return sqlite.prepare(`PRAGMA table_info("${table}")`).all().map((row) => {
      const { name } = row as { name: string };
      return name;
    });
  } finally {
    sqlite.close();
  }
}

function seedDatabaseThatSkippedRunExpiryMigration(dbFile: string): void {
  const sqlite = new Database(dbFile);
  try {
    sqlite.exec(`
      CREATE TABLE "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      );

      INSERT INTO "__drizzle_migrations" ("hash", "created_at")
      VALUES ('already-at-0004', 1789070000000);

      CREATE TABLE "projects" (
        id text PRIMARY KEY,
        name text NOT NULL,
        artifact_retention_days integer DEFAULT 30 NOT NULL
      );

      CREATE TABLE "artifacts" (
        id integer PRIMARY KEY,
        run_id text NOT NULL
      );
    `);
  } finally {
    sqlite.close();
  }
}

async function openClient() {
  const client = await import('@/db/client');
  closeDb = client.closeDb;
  client.getDb();
}

describe('database client startup repair', () => {
  it('repairs columns from the out-of-order run expiry migration', async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-db-repair-'));
    process.env.DEV_COCKPIT_DATA_DIR = dataDir;
    const dbFile = path.join(dataDir, 'cockpit.db');
    seedDatabaseThatSkippedRunExpiryMigration(dbFile);

    await openClient();

    expect(columns(dbFile, 'projects')).toContain('worktree_retention_days');
    expect(columns(dbFile, 'artifacts')).toContain('expired_at');

    closeDb?.();
    closeDb = null;
    vi.resetModules();

    await openClient();

    expect(columns(dbFile, 'projects')).toContain('worktree_retention_days');
    expect(columns(dbFile, 'artifacts')).toContain('expired_at');
  });
});
