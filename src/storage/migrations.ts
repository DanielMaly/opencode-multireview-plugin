import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SqliteDatabase } from "./database.js"

const SELECT_APPLIED_MIGRATIONS_SQL = "SELECT version, name, checksum FROM schema_migrations ORDER BY version"
const INSERT_SCHEMA_MIGRATION_SQL = "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"

interface Migration {
  version: number
  name: string
  path: string
  checksum: string
  sql: string
}

const migrationPattern = /^(\d{3})_([a-z0-9_]+)\.sql$/

function migrationDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../assets/migrations")
}

function discoverMigrations(directory = migrationDirectory()): Migration[] {
  const migrations = readdirSync(directory)
    .map((name) => {
      const match = migrationPattern.exec(name)
      if (!match) return undefined
      const sql = readFileSync(join(directory, name), "utf8")
      return {
        version: Number(match[1]),
        name: match[2],
        path: join(directory, name),
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      }
    })
    .filter((migration): migration is Migration => migration !== undefined)
    .sort((left, right) => left.version - right.version)

  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index]
    if (index > 0 && migration.version === migrations[index - 1].version) throw new Error(`duplicate migration version ${migration.version}`)
    if (migration.version !== index + 1) throw new Error(`migration versions must be contiguous from 001; found ${migration.version}`)
  }
  return migrations
}

export function applyMigrations(database: SqliteDatabase, directory?: string): void {
  const migrations = discoverMigrations(directory)
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)")
  const applied = database.prepare(SELECT_APPLIED_MIGRATIONS_SQL).all() as Array<{
    version: number
    name: string
    checksum: string
  }>
  for (const row of applied) {
    const migration = migrations.find((candidate) => candidate.version === row.version)
    if (!migration || migration.name !== row.name || migration.checksum !== row.checksum) {
      throw new Error(`migration checksum mismatch for version ${row.version}`)
    }
  }
  const appliedVersions = new Set(applied.map((row) => row.version))
  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue
    try {
      database.exec("BEGIN IMMEDIATE")
      database.exec(migration.sql)
      database.prepare(INSERT_SCHEMA_MIGRATION_SQL).run(
        migration.version,
        migration.name,
        migration.checksum,
        new Date().toISOString(),
      )
      database.exec("COMMIT")
    } catch (error) {
      try {
        database.exec("ROLLBACK")
      } catch {
        // Preserve the migration failure if rollback itself cannot run.
      }
      throw new Error(`migration ${migration.version}_${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      })
    }
  }
}

export function migrationFiles(directory = migrationDirectory()): string[] {
  return discoverMigrations(directory).map((migration) => migration.path)
}
