import type { DownloadItem } from 'electron'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import type { BrowserDownloadChange } from '../shared/browser-download.js'
import { BrowserDownloads } from './browser-downloads.js'

const shell = vi.hoisted(() => ({
  openPath: vi.fn(async () => ''),
  showItemInFolder: vi.fn(),
}))
vi.mock('electron', () => ({ shell }))
beforeEach(() => vi.clearAllMocks())

function startDownload(downloads: BrowserDownloads, path: string) {
  const item = Object.assign(new EventEmitter(), {
    getFilename: () => basename(path),
    getSavePath: () => path,
    getURL: () => 'https://example.test/download',
    getTotalBytes: () => 10,
    getReceivedBytes: () => 10,
    getState: vi.fn<DownloadItem['getState']>(() => 'progressing'),
    isPaused: () => false,
    canResume: () => true,
    resume: vi.fn(),
    cancel: vi.fn(),
  })
  downloads.track({ label: 'task', nativeLabel: 'native' }, item as unknown as DownloadItem)
  return item
}

function finishDownload(downloads: BrowserDownloads, path: string, state = 'completed') {
  startDownload(downloads, path).emit('done', {}, state)
}

test('a failed history insert retains file actions by trusted ID until history is removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-download-write-failure-'))
  const changes: BrowserDownloadChange[] = []
  const downloads = new BrowserDownloads(directory, event => changes.push(event))
  const db = new DatabaseSync(join(directory, 'browser-download-history.sqlite'))
  try {
    await downloads.list()
    const file = join(directory, 'video.mp4')
    await writeFile(file, 'video data')
    finishDownload(downloads, file)
    const [saved] = (await downloads.list()).downloads
    db.exec(`CREATE TRIGGER reject_inserts BEFORE INSERT ON downloads BEGIN
      SELECT RAISE(ABORT, 'simulated full disk'); END`)
    finishDownload(downloads, file)
    finishDownload(downloads, file, 'interrupted')
    const { downloads: records } = await downloads.list()
    expect(records).toHaveLength(3)
    const completed = records.find(row => row.status === 'finished' && row.id !== saved!.id)!
    const failed = records.find(row => row.status === 'failed')!
    expect(completed.fileExists).toBe(true)
    expect(db.prepare('SELECT id FROM downloads').all()).toEqual([{ id: saved!.id }])
    await downloads.openFile(completed.id, false)
    await downloads.openFile(completed.id, true)
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(file)
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(file)
    await expect(downloads.openFile(file, true)).rejects.toThrow('unavailable')
    await expect(downloads.openFile(failed.id, false)).rejects.toThrow('unavailable')
    db.prepare('DELETE FROM downloads WHERE id = ?').run(saved!.id)
    await expect(downloads.openFile(saved!.id, false)).rejects.toThrow('unavailable')
    await rm(file)
    expect(
      (await downloads.list()).downloads.find(row => row.id === completed.id)?.fileExists
    ).toBe(false)
    await expect(downloads.openFile(completed.id, true)).rejects.toThrow('unavailable')
    await writeFile(file, 'video data')
    downloads.removeRecord(completed.id)
    expect(changes.at(-1)).toMatchObject({
      id: completed.id,
      status: 'deleted',
      historyRemoval: true,
    })
    await expect(downloads.openFile(completed.id, false)).rejects.toThrow('unavailable')
    downloads.clearHistory()
    expect((await downloads.list()).downloads).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('video data')
  } finally {
    db.close()
    downloads.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a paused download can resume and complete while the database is unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-download-open-failure-'))
  const downloads = new BrowserDownloads(directory, () => {})
  try {
    await mkdir(join(directory, 'browser-download-history.sqlite'))
    const file = join(directory, 'video.mp4')
    await writeFile(file, 'video data')
    const item = startDownload(downloads, file)
    item.emit('updated', {}, 'interrupted')
    const paused = await downloads.list()
    expect(paused).toMatchObject({ historyUnavailable: true, downloads: [{ status: 'paused' }] })
    const id = paused.downloads[0]!.id
    downloads.resume(id)
    expect(item.resume).toHaveBeenCalledOnce()
    expect(await downloads.list()).toMatchObject({
      historyUnavailable: true,
      downloads: [{ id, status: 'progress' }],
    })
    item.emit('done', {}, 'completed')
    const snapshot = await downloads.list()
    expect(snapshot.historyUnavailable).toBe(true)
    const [record] = snapshot.downloads
    expect(record).toMatchObject({ status: 'finished', fileExists: true })
    await downloads.openFile(record!.id, true)
    expect(shell.showItemInFolder).toHaveBeenCalledWith(file)
    downloads.removeRecord(record!.id)
    await expect(downloads.list()).rejects.toThrow()
  } finally {
    downloads.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test.each(['delete', 'stop'] as const)(
  '%s cancels a resumable interrupted download before releasing it',
  async action => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-download-interrupted-'))
    const downloads = new BrowserDownloads(directory, () => {})
    const file = join(directory, 'partial.mp4')
    try {
      await writeFile(file, 'partial')
      const item = startDownload(downloads, file)
      item.getState.mockReturnValue('interrupted')
      item.emit('updated', {}, 'interrupted')
      const [record] = (await downloads.list()).downloads
      expect(record).toMatchObject({ status: 'paused' })

      item.cancel.mockImplementation(() => item.emit('done', {}, 'cancelled'))
      if (action === 'delete') await downloads.delete(record!.id)
      else downloads.stop()
      expect(item.cancel).toHaveBeenCalledOnce()
      expect((await downloads.list()).downloads).toEqual([])
      if (action === 'delete')
        await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      downloads.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test('clears pending records and resets a corrupt history database on explicit clear', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-download-corrupt-history-'))
  const changes: BrowserDownloadChange[] = []
  const downloads = new BrowserDownloads(directory, event => changes.push(event))
  const reopened = new BrowserDownloads(directory, () => {})
  const file = join(directory, 'video.mp4')
  try {
    await writeFile(join(directory, 'browser-download-history.sqlite'), 'corrupt SQLite fixture')
    await writeFile(file, 'downloaded file')
    finishDownload(downloads, file)
    expect(await downloads.list()).toMatchObject({
      historyUnavailable: true,
      downloads: [{ fileName: 'video.mp4' }],
    })

    downloads.clearHistory()
    expect(changes.at(-1)).toMatchObject({ cleared: true })
    expect(await downloads.list()).toMatchObject({ historyUnavailable: false, downloads: [] })
    expect(await reopened.list()).toMatchObject({ historyUnavailable: false, downloads: [] })
    expect(await readFile(file, 'utf8')).toBe('downloaded file')
  } finally {
    downloads.stop()
    reopened.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a write failure while a retry checks files publishes a newer history status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-download-retry-race-'))
  const changes: BrowserDownloadChange[] = []
  const downloads = new BrowserDownloads(directory, event => changes.push(event))
  const db = new DatabaseSync(join(directory, 'browser-download-history.sqlite'))
  const first = join(directory, 'first.mp4')
  const second = join(directory, 'second.mp4')
  try {
    await Promise.all([writeFile(first, 'first'), writeFile(second, 'second')])
    await downloads.list()
    db.exec('BEGIN EXCLUSIVE')
    finishDownload(downloads, first)
    db.exec('ROLLBACK')

    // The retry commits before yielding to the filesystem. Fail the next write before it returns.
    const retry = downloads.list()
    db.exec('BEGIN EXCLUSIVE')
    finishDownload(downloads, second)
    const snapshot = await retry
    expect(snapshot).toMatchObject({
      historyUnavailable: false,
      downloads: [{ fileName: 'first.mp4', fileExists: true }],
    })
    expect(db.prepare('SELECT fileName FROM downloads').all()).toEqual([{ fileName: 'first.mp4' }])
    const history = changes.filter(event => 'historyUnavailable' in event)
    expect(history.map(event => event.historyUnavailable)).toEqual([true, false, true])
    expect(history.at(-1)?.revision).toBeGreaterThan(snapshot.revision)

    db.exec('ROLLBACK')
    const recovered = await downloads.list()
    expect(recovered.historyUnavailable).toBe(false)
    expect(recovered.downloads.map(record => record.fileName).sort()).toEqual([
      'first.mp4',
      'second.mp4',
    ])
    expect(changes.at(-1)).toMatchObject({
      historyUnavailable: false,
      revision: recovered.revision,
    })
  } finally {
    db.close()
    downloads.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test.each(['list retry', 'download completion'])(
  '%s restores pending downloads across restarts',
  async trigger => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-download-write-recovery-'))
    let downloads = new BrowserDownloads(directory, () => {})
    const db = new DatabaseSync(join(directory, 'browser-download-history.sqlite'))
    const finish = (name: string) => finishDownload(downloads, join(directory, name))
    const stored = () => db.prepare('SELECT fileName FROM downloads ORDER BY fileName').all()
    try {
      await downloads.list()
      db.exec(`CREATE TRIGGER block_inserts BEFORE INSERT ON downloads BEGIN
      SELECT RAISE(ABORT, 'simulated full disk'); END`)
      finish('cleared')
      downloads.clearHistory()
      finish('removed')
      const [removed] = (await downloads.list()).downloads
      downloads.removeRecord(removed!.id)
      finish('keep-first')
      finish('keep-second')
      db.exec(`DROP TRIGGER block_inserts;
      CREATE TRIGGER block_one BEFORE INSERT ON downloads WHEN NEW.fileName = 'keep-second'
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`)
      finish('new-first')
      expect(stored()).toEqual([{ fileName: 'new-first' }])
      const partial = await downloads.list()
      expect(partial.downloads).toHaveLength(3)
      expect(partial.historyUnavailable).toBe(true)
      db.exec('DROP TRIGGER block_one')
      const expected = ['keep-first', 'keep-second', 'new-first']
      if (trigger === 'list retry') {
        const retry = await downloads.list()
        expect(retry.historyUnavailable).toBe(false)
        expect(retry.downloads.map(row => row.fileName).sort()).toEqual(expected)
      } else {
        finish('new-second')
        expected.push('new-second')
      }
      expect(stored().map(row => row.fileName)).toEqual(expected)
      const { downloads: recovered } = await downloads.list()
      expect(recovered.map(row => row.fileName).sort()).toEqual(expected)
      downloads.stop()
      downloads = new BrowserDownloads(directory, () => {})
      expect((await downloads.list()).downloads).toEqual(recovered)
    } finally {
      db.close()
      downloads.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
