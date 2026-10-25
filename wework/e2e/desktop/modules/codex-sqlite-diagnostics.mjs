import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export async function collectCodexSqliteDiagnostics(directory, threadId) {
  try {
    const files = []
    for (const name of await readdir(directory)) {
      if (!/\.sqlite(?:-wal|-shm)?$/.test(name)) continue
      const metadata = await stat(join(directory, name))
      const entry = { name, bytes: metadata.size }
      if (name.endsWith('.sqlite')) {
        let database
        try {
          database = new DatabaseSync(join(directory, name), { readOnly: true })
          entry.integrity = database.prepare('PRAGMA quick_check').all()
          if (name === 'state_5.sqlite' && threadId) {
            entry.thread =
              database.prepare('SELECT id, history_mode FROM threads WHERE id = ?').get(threadId) ??
              null
          }
          if (name === 'thread_history_1.sqlite') {
            entry.recentItems = database
              .prepare(
                `SELECT thread_id, turn_id, item_id, item_type,
                json_extract(item_json, '$.phase') AS phase,
                length(item_json) AS jsonLength
                FROM thread_items ORDER BY rollout_ordinal DESC LIMIT 40`
              )
              .all()
          }
        } catch (error) {
          entry.errorCode = error.code ?? null
          entry.sqliteCode = error.errcode ?? null
          entry.sqliteError = error.errstr ?? null
        } finally {
          database?.close()
        }
      }
      files.push(entry)
    }
    return { files }
  } catch (error) {
    return { errorCode: error.code ?? null }
  }
}
