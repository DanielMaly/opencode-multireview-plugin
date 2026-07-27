import { createRequire } from "node:module"
import { ensureDatabaseDirectory, resolveDatabasePath } from "./path.js"
import { applyMigrations } from "./migrations.js"

export interface SqliteStatement {
  get(...parameters: unknown[]): Record<string, unknown> | undefined
  all(...parameters: unknown[]): Array<Record<string, unknown>>
  run(...parameters: unknown[]): { changes: number; lastInsertRowid: number | bigint }
}

export interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

export interface DatabaseOptions {
  databasePath?: string
  migrationDirectory?: string
}

interface NativeStatement {
  get(...parameters: unknown[]): unknown
  all(...parameters: unknown[]): unknown
  run(...parameters: unknown[]): unknown
}

interface NativeDatabase {
  exec(sql: string): void
  prepare?(sql: string): NativeStatement
  query?(sql: string): NativeStatement
  close(): void
}

class StatementAdapter implements SqliteStatement {
  constructor(private readonly statement: NativeStatement) {}

  get(...parameters: unknown[]): Record<string, unknown> | undefined {
    const row = this.statement.get(...parameters)
    return row === null ? undefined : row as Record<string, unknown> | undefined
  }

  all(...parameters: unknown[]): Array<Record<string, unknown>> {
    return this.statement.all(...parameters) as Array<Record<string, unknown>>
  }

  run(...parameters: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.statement.run(...parameters) as { changes: number; lastInsertRowid: number | bigint }
  }
}

class DatabaseAdapter implements SqliteDatabase {
  constructor(private readonly database: NativeDatabase, private readonly isBun: boolean) {}

  exec(sql: string): void {
    this.database.exec(sql)
  }

  prepare(sql: string): SqliteStatement {
    const statement = this.isBun ? this.database.query?.(sql) : this.database.prepare?.(sql)
    if (!statement) throw new Error("SQLite runtime does not provide prepared statements")
    return new StatementAdapter(statement)
  }

  close(): void {
    this.database.close()
  }
}

function openNativeDatabase(databasePath: string): SqliteDatabase {
  const isBun = Boolean(process.versions.bun)
  const moduleName = isBun ? "bun:sqlite" : "node:sqlite"
  const nativeModule = createRequire(import.meta.url)(moduleName) as {
    Database?: new (path: string) => NativeDatabase
    DatabaseSync?: new (path: string) => NativeDatabase
  }
  const DatabaseConstructor = isBun ? nativeModule.Database : nativeModule.DatabaseSync
  if (!DatabaseConstructor) throw new Error(`SQLite runtime ${moduleName} does not expose a supported database constructor`)
  return new DatabaseAdapter(new DatabaseConstructor(databasePath), isBun)
}

export function openDatabase(options: DatabaseOptions = {}): SqliteDatabase {
  const databasePath = options.databasePath ?? resolveDatabasePath()
  ensureDatabaseDirectory(databasePath)
  const database = openNativeDatabase(databasePath)
  try {
    database.exec("PRAGMA foreign_keys = ON")
    database.exec("PRAGMA busy_timeout = 5000")
    database.exec("PRAGMA journal_mode = DELETE")
    applyMigrations(database, options.migrationDirectory)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

export function withDatabase<T>(options: DatabaseOptions, operation: (database: SqliteDatabase) => T): T {
  const database = openDatabase(options)
  try {
    return operation(database)
  } finally {
    database.close()
  }
}
