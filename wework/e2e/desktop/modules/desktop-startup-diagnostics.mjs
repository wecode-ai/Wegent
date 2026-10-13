import { copyFile, lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const CODEX_DATABASE =
  /^(?:state|logs|goals|memories|memories_v2|queue|thread_history)_\d+\.sqlite$/

function errorCode(error) {
  return { code: error?.code ?? null, sqliteCode: error?.errcode ?? null }
}

export function observeDesktopAppProcess(child) {
  const state = {
    pid: child.pid ?? null,
    exitCode: child.exitCode ?? null,
    signal: child.signalCode ?? null,
    spawnError: null,
  }
  child.once('error', error => {
    state.spawnError = errorCode(error)
  })
  child.once('exit', (exitCode, signal) => {
    state.exitCode = exitCode
    state.signal = signal
  })
  return state
}

export async function collectCodexSqliteHealth(directory) {
  let entries
  try {
    entries = await readdir(directory)
  } catch (error) {
    return { directoryError: errorCode(error), files: [] }
  }
  const files = []
  for (const name of entries.filter(name => CODEX_DATABASE.test(name)).sort()) {
    const file = { name }
    let database
    try {
      const path = join(directory, name)
      const metadata = await lstat(path)
      file.size = metadata.size
      file.mode = metadata.mode
      file.regularFile = metadata.isFile()
      if (!file.regularFile) {
        files.push(file)
        continue
      }
      // Even a read-only WAL connection can write shared-memory sidecars. Inspect
      // disposable byte copies instead of opening the application's live files.
      const snapshot = await mkdtemp(join(tmpdir(), 'wework-sqlite-health-'))
      file.snapshotChecks = true
      try {
        await copyFile(path, join(snapshot, name))
        for (const suffix of ['-wal', '-shm']) {
          try {
            const sidecar = await lstat(`${path}${suffix}`)
            if (sidecar.isFile())
              await copyFile(`${path}${suffix}`, join(snapshot, `${name}${suffix}`))
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error
          }
        }
        database = new DatabaseSync(join(snapshot, name), { readOnly: true })
        const issues = database
          .prepare('PRAGMA quick_check')
          .all()
          .filter(row => row.quick_check !== 'ok')
        file.quickCheck = { passed: issues.length === 0, issueCount: issues.length }
        file.userVersion = database.prepare('PRAGMA user_version').get().user_version
        const migrations = database
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_sqlx_migrations'")
          .get()
        file.migrations = migrations
          ? database.prepare('SELECT version, success FROM _sqlx_migrations ORDER BY version').all()
          : []
      } finally {
        try {
          database?.close()
        } finally {
          await rm(snapshot, { recursive: true, force: true })
        }
      }
    } catch (error) {
      file.error = errorCode(error)
    }
    files.push(file)
  }
  return { files }
}
