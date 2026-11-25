import { shell, type DownloadItem } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  BROWSER_DOWNLOAD_SNAPSHOT_SIZE,
  browserDownloadSnapshot,
  type BrowserDownloadChange,
  type BrowserDownloadList,
  type BrowserDownloadRecord,
} from '../shared/browser-download.js'

const FILE_CHECK_BATCH_SIZE = 8
const DOWNLOAD_HISTORY_FILE = 'browser-download-history.sqlite'
const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26
const columns =
  'id, label, nativeLabel, fileName, path, status, receivedBytes, totalBytes, startedAtMs, updatedAtMs'
const insertSql = `INSERT INTO downloads (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

function insertDownload(statement: StatementSync, record: BrowserDownloadRecord): void {
  statement.run(
    record.id,
    record.label,
    record.nativeLabel,
    record.fileName,
    record.path,
    record.status,
    record.receivedBytes,
    record.totalBytes,
    record.startedAtMs,
    record.updatedAtMs
  )
}

function cancelUnfinishedDownload(item: DownloadItem): void {
  const state = item.getState()
  if (state === 'progressing' || state === 'interrupted') item.cancel()
}

function isCorruptDatabase(error: unknown): boolean {
  if (!(error instanceof Error) || !('errcode' in error) || typeof error.errcode !== 'number') {
    return false
  }
  const code = error.errcode & 0xff // The low byte is the primary SQLite result code.
  return code === SQLITE_CORRUPT || code === SQLITE_NOTADB
}

/** The browser profile owns history. Only the live owner receives activity and completion hints. */
export class BrowserDownloads {
  private db: DatabaseSync | undefined
  private revision = 0
  private historyReadFailed = false
  private historyUnavailable = false
  private readonly active = new Map<string, { item: DownloadItem; record: BrowserDownloadRecord }>()
  private readonly unsaved = new Map<string, BrowserDownloadRecord>()

  constructor(
    private readonly directory: string,
    private readonly publish: (event: BrowserDownloadChange) => void
  ) {}

  private database(): DatabaseSync {
    if (this.db) return this.db
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(join(this.directory, DOWNLOAD_HISTORY_FILE))
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS downloads (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, nativeLabel TEXT NOT NULL, fileName TEXT NOT NULL,
        path TEXT, status TEXT NOT NULL, receivedBytes INTEGER NOT NULL, totalBytes INTEGER NOT NULL,
        startedAtMs INTEGER NOT NULL, updatedAtMs INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS downloads_by_start ON downloads(startedAtMs DESC, id ASC);`)
      this.db = db
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }

  track(owner: { label: string; nativeLabel: string }, item: DownloadItem): void {
    const id = randomUUID()
    const startedAtMs = Date.now()
    const record: BrowserDownloadRecord = {
      id,
      label: owner.label,
      nativeLabel: owner.nativeLabel,
      fileName: item.getFilename(),
      path: null,
      status: 'started',
      receivedBytes: 0,
      totalBytes: 0,
      startedAtMs,
      updatedAtMs: startedAtMs,
    }
    this.active.set(id, { item, record })
    const update = (status: BrowserDownloadRecord['status'], done = false) => {
      if (!this.active.has(id)) return
      record.status = status
      record.path = item.getSavePath() || record.path
      if (record.path) record.fileName = basename(record.path)
      record.receivedBytes = item.getReceivedBytes()
      record.totalBytes = item.getTotalBytes()
      record.updatedAtMs = Date.now()
      if (done) {
        this.active.delete(id)
        this.saveFinished(record)
      }
      this.publish({ ...record, revision: ++this.revision })
    }
    update('started')
    item.on('updated', (_event, state) => {
      const paused = item.isPaused() || (state === 'interrupted' && item.canResume())
      update(paused ? 'paused' : 'progress')
    })
    item.once('done', (_event, state) =>
      update(state === 'completed' ? 'finished' : 'failed', true)
    )
  }

  private saveFinished(record: BrowserDownloadRecord): void {
    let db: DatabaseSync
    try {
      db = this.database()
      insertDownload(db.prepare(insertSql), record)
    } catch (error) {
      this.unsaved.set(record.id, record)
      console.warn('[downloads] Failed to save completed download to history', error)
      this.publishHistoryStatus()
      return
    }
    this.restoreUnsaved(db)
    this.publishHistoryStatus()
  }

  private restoreUnsaved(db: DatabaseSync): void {
    if (!this.unsaved.size) return
    try {
      const insert = db.prepare(insertSql)
      db.exec('BEGIN')
      for (const pending of this.unsaved.values()) insertDownload(insert, pending)
      db.exec('COMMIT')
      this.unsaved.clear()
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      console.warn('[downloads] Failed to restore unsaved download history', error)
    }
  }

  private publishHistoryStatus(): void {
    const historyUnavailable = this.historyReadFailed || this.unsaved.size > 0
    if (historyUnavailable === this.historyUnavailable) return
    this.historyUnavailable = historyUnavailable
    this.publish({ historyUnavailable, revision: ++this.revision })
  }

  relabel(from: string, to: string): void {
    for (const { record } of this.active.values()) {
      if (record.label === from) record.label = to
    }
  }

  pause(id: string): void {
    const { item, record } = this.requiredActive(id)
    if (item.getState() === 'progressing') {
      item.pause()
      record.status = 'paused'
      this.publish({ ...record, revision: ++this.revision })
    }
  }

  resume(id: string): void {
    const { item, record } = this.requiredActive(id)
    if (!item.canResume()) throw new Error('Embedded browser download cannot resume')
    item.resume()
    record.status = 'progress'
    this.publish({ ...record, revision: ++this.revision })
  }

  private requiredActive(id: string) {
    const active = this.active.get(id)
    if (!active) throw new Error('Embedded browser download is no longer active')
    return active
  }

  async delete(id: string): Promise<void> {
    const { item, record } = this.requiredActive(id)
    this.active.delete(id)
    try {
      cancelUnfinishedDownload(item)
      if (record.path) await rm(record.path, { force: true })
    } catch (error) {
      record.status = 'failed'
      this.saveFinished(record)
      this.publish({ ...record, revision: ++this.revision })
      throw error
    }
    this.publish({ ...record, status: 'deleted', revision: ++this.revision })
  }

  removeRecord(id: string): void {
    const record =
      this.unsaved.get(id) ??
      this.database().prepare('DELETE FROM downloads WHERE id = ? RETURNING *').get(id)
    if (!record) return
    this.unsaved.delete(id)
    this.publishHistoryStatus()
    this.publish({
      ...(record as unknown as BrowserDownloadRecord),
      status: 'deleted',
      historyRemoval: true,
      revision: ++this.revision,
    })
  }

  clearHistory(): void {
    try {
      this.database().prepare('DELETE FROM downloads').run()
    } catch (error) {
      if (!isCorruptDatabase(error)) throw error
      this.db?.close()
      this.db = undefined
      // Clear owns this history file and its journals. A future access creates a fresh database.
      for (const suffix of ['-journal', '-wal', '-shm', '']) {
        rmSync(join(this.directory, DOWNLOAD_HISTORY_FILE + suffix), { force: true })
      }
    }
    this.unsaved.clear()
    this.historyReadFailed = false
    this.publishHistoryStatus()
    this.publish({ cleared: true, revision: ++this.revision })
  }

  async list(): Promise<BrowserDownloadList> {
    const records = [
      ...Array.from(this.active.values(), ({ record }) => ({ ...record })),
      ...Array.from(this.unsaved.values(), record => ({ ...record })),
    ]
    try {
      const db = this.database()
      const stored = db
        .prepare(`SELECT ${columns} FROM downloads ORDER BY startedAtMs DESC, id ASC LIMIT ?`)
        .all(Math.max(0, BROWSER_DOWNLOAD_SNAPSHOT_SIZE - this.active.size))
      records.push(...(stored as unknown as BrowserDownloadRecord[]))
      // This snapshot already contains pending rows. Flush after reading to include each ID once.
      this.restoreUnsaved(db)
      this.historyReadFailed = false
    } catch (error) {
      this.historyReadFailed = true
      if (!records.length) throw error
      console.warn('[downloads] Failed to read download history', error)
    } finally {
      this.publishHistoryStatus()
    }
    // Newer events can arrive while the filesystem checks this snapshot.
    const { revision, historyUnavailable, historyReadFailed } = this
    const downloads = browserDownloadSnapshot(records)
    for (let offset = 0; offset < downloads.length; offset += FILE_CHECK_BATCH_SIZE) {
      const batch = downloads.slice(offset, offset + FILE_CHECK_BATCH_SIZE)
      await Promise.all(
        batch.map(async record => {
          if (record.status === 'finished') record.fileExists = await isFile(record.path)
        })
      )
    }
    return { revision, downloads, historyUnavailable, historyReadFailed }
  }

  async openFile(id: string, reveal: boolean): Promise<void> {
    const record =
      this.unsaved.get(id) ??
      this.database().prepare('SELECT status, path FROM downloads WHERE id = ?').get(id)
    const path = record?.path
    if (record?.status !== 'finished' || typeof path !== 'string' || !(await isFile(path)))
      throw new Error('Downloaded file is unavailable')
    if (reveal) shell.showItemInFolder(path)
    else {
      const error = await shell.openPath(path)
      if (error) throw new Error(error)
    }
  }

  stop(): void {
    const activeDownloads = [...this.active.values()]
    this.active.clear()
    for (const { item } of activeDownloads) cancelUnfinishedDownload(item)
    this.unsaved.clear()
    this.db?.close()
    this.db = undefined
  }
}

async function isFile(path: string | null): Promise<boolean | undefined> {
  if (!path) return false
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? false : undefined
  }
}
