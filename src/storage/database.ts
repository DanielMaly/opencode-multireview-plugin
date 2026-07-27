import { DatabaseSync } from "node:sqlite"
import { ensureDatabaseDirectory, resolveDatabasePath } from "./path.js"
import { applyMigrations } from "./migrations.js"

export interface DatabaseOptions {
  databasePath?: string
  migrationDirectory?: string
}

export function openDatabase(options: DatabaseOptions = {}): DatabaseSync {
  const databasePath = options.databasePath ?? resolveDatabasePath()
  ensureDatabaseDirectory(databasePath)
  const database = new DatabaseSync(databasePath)
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

export function withDatabase<T>(options: DatabaseOptions, operation: (database: DatabaseSync) => T): T {
  const database = openDatabase(options)
  try {
    return operation(database)
  } finally {
    database.close()
  }
}
