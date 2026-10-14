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

export async function collectCodexSqliteHealth(directory, { threadId } = {}) {
  let entries
  try {
    entries = await readdir(directory)
  } catch (error) {
    return threadId
      ? { status: 'unavailable', files: [] }
      : { directoryError: errorCode(error), files: [] }
  }
  const files = []
  for (const name of entries.filter(name => CODEX_DATABASE.test(name)).sort()) {
    if (threadId && !/^state_\d+\.sqlite$/.test(name)) continue
    const file = { name }
    let database
    try {
      const path = join(directory, name)
      const metadata = await lstat(path)
      file.size = metadata.size
      file.mode = metadata.mode
      file.regularFile = metadata.isFile()
      if (threadId) file.wal = { present: false, size: 0 }
      if (!file.regularFile) {
        if (threadId) file.thread = { status: 'unavailable' }
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
            if (threadId && suffix === '-wal')
              file.wal = { present: sidecar.isFile(), size: sidecar.size }
            if (sidecar.isFile())
              await copyFile(`${path}${suffix}`, join(snapshot, `${name}${suffix}`))
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error
          }
        }
        database = new DatabaseSync(join(snapshot, name), { readOnly: true })
        if (threadId) {
          const columns = database.prepare('PRAGMA table_info(threads)').all()
          if (!['id', 'history_mode'].every(name => columns.some(column => column.name === name))) {
            file.thread = { status: 'unsupported-schema' }
          } else {
            const row = database
              .prepare('SELECT history_mode FROM threads WHERE id = ?')
              .get(threadId)
            file.thread = {
              status: 'available',
              exists: row !== undefined,
              historyMode: row
                ? ['legacy', 'paginated'].includes(row.history_mode)
                  ? row.history_mode
                  : 'unknown'
                : null,
            }
          }
        } else {
          const issues = database
            .prepare('PRAGMA quick_check')
            .all()
            .filter(row => row.quick_check !== 'ok')
          file.quickCheck = { passed: issues.length === 0, issueCount: issues.length }
          file.userVersion = database.prepare('PRAGMA user_version').get().user_version
          const migrations = database
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_sqlx_migrations'"
            )
            .get()
          file.migrations = migrations
            ? database
                .prepare('SELECT version, success FROM _sqlx_migrations ORDER BY version')
                .all()
            : []
        }
      } finally {
        try {
          database?.close()
        } finally {
          await rm(snapshot, { recursive: true, force: true })
        }
      }
    } catch (error) {
      if (threadId) file.thread = { status: 'unavailable' }
      else file.error = errorCode(error)
    }
    files.push(file)
  }
  return { files }
}
