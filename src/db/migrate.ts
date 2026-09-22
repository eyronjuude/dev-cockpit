import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import path from 'node:path';

import * as schema from './schema';

interface TableInfoRow {
  name: unknown;
}

export function migrationsFolder(): string {
  // Resolved from cwd rather than import.meta.url: Next copies compiled output
  // into .next, and the SQL files are not part of that bundle.
  return path.join(process.cwd(), 'src', 'db', 'migrations');
}

/**
 * Runs the Drizzle migrator plus the additive-column repair below against an
 * already-open handle. The one entry point both `client.ts`'s in-process open
 * and the standalone `db:migrate` script call, so a database migrated outside
 * the app is never left short of the repair.
 */
export function applyMigrations(sqlite: Database.Database): void {
  const db = drizzle(sqlite, { schema });

  const folder = migrationsFolder();
  if (fs.existsSync(folder)) {
    migrate(db, { migrationsFolder: folder });
  } else {
    throw new Error(
      `Database migrations are missing at ${folder}. Run "npm run db:generate" first.`,
    );
  }

  repairSkippedAdditiveMigrations(sqlite);
}

function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  const rows = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as TableInfoRow[];
  return rows.some((row) => row.name === column);
}

/**
 * A missing table is not a table missing a column.
 *
 * `PRAGMA table_info` returns nothing for both, so without this the repair
 * would try to `ALTER` a table that does not exist yet and take the whole
 * database open down with it.
 */
function tableExists(sqlite: Database.Database, table: string): boolean {
  const row = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return row !== undefined;
}

/**
 * Migration 0006 was created with a timestamp older than migrations already
 * present in some local databases. Drizzle compares pending migrations against
 * the latest `created_at`, so those databases can skip the file even though the
 * schema still needs these additive columns.
 */
function repairSkippedAdditiveMigrations(sqlite: Database.Database): void {
  if (tableExists(sqlite, 'artifacts') && !columnExists(sqlite, 'artifacts', 'expired_at')) {
    sqlite.prepare('ALTER TABLE "artifacts" ADD "expired_at" text').run();
  }

  if (tableExists(sqlite, 'projects') && !columnExists(sqlite, 'projects', 'worktree_retention_days')) {
    sqlite
      .prepare(
        'ALTER TABLE "projects" ADD "worktree_retention_days" integer DEFAULT 7 NOT NULL',
      )
      .run();
  }

  // 0007. Additive and nullable throughout, so adding a column that migration
  // already applied is the only thing this has to avoid.
  if (!tableExists(sqlite, 'iterations')) return;
  for (const column of [
    'model',
    'effort',
    'permission_mode',
    'input_tokens',
    'output_tokens',
    'thinking_tokens',
    'cache_read_tokens',
    'cache_creation_tokens',
  ]) {
    if (columnExists(sqlite, 'iterations', column)) continue;
    const type = column.endsWith('_tokens') ? 'integer' : 'text';
    sqlite.prepare(`ALTER TABLE "iterations" ADD "${column}" ${type}`).run();
  }
}
