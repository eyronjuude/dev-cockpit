import Database from 'better-sqlite3';

import { applyMigrations } from '../src/db/migrate';
import { dataDir, dbPath, ensureDir } from '../src/core/paths';

ensureDir(dataDir());
const file = dbPath();
const sqlite = new Database(file);
try {
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  console.log(`Migrations applied to ${file}`);
} finally {
  sqlite.close();
}
