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

      -- Present since 0000, so a database that reached 0004 has it. Seeded
      -- because later additive migrations target it, and a fixture missing a
      -- table that has always existed tests a state no real database is in.
      CREATE TABLE "iterations" (
        id text PRIMARY KEY,
        run_id text NOT NULL,
        ordinal integer NOT NULL
      );

      -- Same reasoning. 0008 reads this table to build the validation_steps
      -- pipeline, and every database that reached 0004 has had it since 0000.
      CREATE TABLE "validation_commands" (
        id integer PRIMARY KEY AUTOINCREMENT,
        project_id text NOT NULL,
        kind text NOT NULL,
        command text NOT NULL,
        working_dir text,
        timeout_ms integer DEFAULT 900000 NOT NULL,
        enabled integer DEFAULT true NOT NULL,
        blocking integer DEFAULT true NOT NULL,
        profiles text DEFAULT 'quick' NOT NULL,
        created_at text NOT NULL DEFAULT '2025-01-01T00:00:00.000Z',
        updated_at text NOT NULL DEFAULT '2025-01-01T00:00:00.000Z'
      );

      -- 0008 rebuilds validation_results to re-key it on step_key, so the
      -- fixture needs the pre-0008 shape for that rebuild to copy from.
      CREATE TABLE "validation_results" (
        id text PRIMARY KEY,
        run_id text NOT NULL,
        attempt integer DEFAULT 1 NOT NULL,
        kind text NOT NULL,
        command_source text DEFAULT 'project' NOT NULL,
        command text,
        working_dir text,
        outcome text DEFAULT 'running' NOT NULL,
        blocking integer DEFAULT true NOT NULL,
        exit_code integer,
        duration_ms integer,
        stdout text,
        stderr text,
        error text,
        started_at text,
        finished_at text,
        created_at text NOT NULL DEFAULT '2025-01-01T00:00:00.000Z'
      );

      CREATE TABLE "runs" (
        id text PRIMARY KEY,
        project_id text NOT NULL
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
    expect(columns(dbFile, 'iterations')).toContain('cache_read_tokens');

    closeDb?.();
    closeDb = null;
    vi.resetModules();

    await openClient();

    expect(columns(dbFile, 'projects')).toContain('worktree_retention_days');
    expect(columns(dbFile, 'artifacts')).toContain('expired_at');
  });
});
