import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  DownloadTargetPolicy,
  sanitizeDownloadFilename,
  type ManagedDownloadItem,
} from './download-target-policy.js'

class FakeDownloadItem extends EventEmitter implements ManagedDownloadItem {
  private savePath = ''
  readonly cancel = vi.fn()
  readonly setSavePath = vi.fn((path: string) => {
    this.savePath = path
  })
  readonly setSaveDialogOptions = vi.fn()

  constructor(
    private readonly filename: string,
    private readonly url = 'https://example.test/video.mp4',
    private readonly urlChain: string[] = [url]
  ) {
    super()
  }

  getFilename(): string {
    return this.filename
  }

  getSavePath(): string {
    return this.savePath
  }

  getURL(): string {
    return this.url
  }

  getURLChain(): string[] {
    return this.urlChain
  }
}

describe('sanitizeDownloadFilename', () => {
  test('strips directory traversal, Windows separators, and control characters', () => {
    expect(sanitizeDownloadFilename('../../secret/video.mp4')).toBe('video.mp4')
    expect(sanitizeDownloadFilename('C:\\Users\\demo\\clip.mp4')).toBe('clip.mp4')
    expect(sanitizeDownloadFilename('clip\u0000\n.mp4')).toBe('clip.mp4')
    expect(sanitizeDownloadFilename('   ')).toBe('download')
    expect(sanitizeDownloadFilename('..')).toBe('download')
  })
})

describe('DownloadTargetPolicy', () => {
  test('saves directly to system Downloads with disk, concurrent, and case-variant deduplication', async () => {
    const downloadsDir = await mkdtemp(join(tmpdir(), 'wework-download-policy-'))
    const onDownloadCompleted = vi.fn()
    try {
      await writeFile(join(downloadsDir, 'video.mp4'), 'existing')
      const policy = new DownloadTargetPolicy({
        defaultDownloadsDirectory: () => downloadsDir,
        onDownloadCompleted,
        caseInsensitivePaths: true,
      })
      await policy.prepare()

      const first = new FakeDownloadItem('video.mp4')
      const second = new FakeDownloadItem('video.mp4')
      const firstResult = policy.apply(first, { id: 1 })
      const secondResult = policy.apply(second, { id: 1 })

      expect(firstResult).toEqual({
        mode: 'save-path',
        path: join(downloadsDir, 'video (1).mp4'),
      })
      expect(secondResult).toEqual({
        mode: 'save-path',
        path: join(downloadsDir, 'video (2).mp4'),
      })
      expect(first.setSavePath).toHaveBeenCalledExactlyOnceWith(join(downloadsDir, 'video (1).mp4'))
      expect(first.setSaveDialogOptions).not.toHaveBeenCalled()
      expect(second.setSavePath).toHaveBeenCalledExactlyOnceWith(
        join(downloadsDir, 'video (2).mp4')
      )

      // Concurrent case-variant downloads reserve distinct paths regardless of host filesystem.
      const upper = new FakeDownloadItem('Report.zip')
      const lower = new FakeDownloadItem('report.zip')
      expect(policy.apply(upper, { id: 1 })).toEqual({
        mode: 'save-path',
        path: join(downloadsDir, 'Report.zip'),
      })
      expect(policy.apply(lower, { id: 1 })).toEqual({
        mode: 'save-path',
        path: join(downloadsDir, 'report (1).zip'),
      })
      upper.emit('done', {}, 'cancelled')
      lower.emit('done', {}, 'cancelled')

      first.emit('done', {}, 'completed')
      second.emit('done', {}, 'cancelled')
      expect(onDownloadCompleted).toHaveBeenCalledExactlyOnceWith(
        join(downloadsDir, 'video (1).mp4')
      )

      // Cancelled reservation is released and available again when no file exists on disk.
      const third = new FakeDownloadItem('video.mp4')
      expect(policy.apply(third, { id: 1 })).toEqual({
        mode: 'save-path',
        path: join(downloadsDir, 'video (1).mp4'),
      })
    } finally {
      await rm(downloadsDir, { recursive: true, force: true })
    }
  })

  test('respects custom download directory, ask-before-download, and one-shot Save As override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-download-custom-'))
    const systemDownloads = join(root, 'system')
    const customDownloads = join(root, 'custom')
    try {
      const policy = new DownloadTargetPolicy({
        defaultDownloadsDirectory: () => systemDownloads,
      })
      await policy.update({
        browserDownloadDirectory: customDownloads,
        browserAskBeforeDownload: false,
      })

      const direct = new FakeDownloadItem('clip.mp4', 'https://example.test/clip.mp4')
      expect(policy.apply(direct, { id: 7 })).toEqual({
        mode: 'save-path',
        path: join(customDownloads, 'clip.mp4'),
      })
      expect(direct.setSavePath).toHaveBeenCalledWith(join(customDownloads, 'clip.mp4'))

      // Explicit Save As prompts once even when askBeforeDownload is false, including redirects.
      const target = new EventEmitter()
      const downloadURL = vi.fn()
      policy.downloadUrlAs(
        {
          id: 7,
          downloadURL,
          once: (event, listener) => target.once(event, listener),
        },
        'https://example.test/start#hash'
      )
      expect(downloadURL).toHaveBeenCalledExactlyOnceWith('https://example.test/start#hash')
      const saveAsItem = new FakeDownloadItem('photo.png', 'https://cdn.example.test/final.png', [
        'https://example.test/start',
        'https://cdn.example.test/final.png',
      ])
      expect(policy.apply(saveAsItem, { id: 7 })).toEqual({
        mode: 'save-dialog',
        path: join(customDownloads, 'photo.png'),
        reason: 'save-as',
      })
      expect(saveAsItem.setSavePath).not.toHaveBeenCalled()
      expect(saveAsItem.setSaveDialogOptions).toHaveBeenCalledExactlyOnceWith({
        defaultPath: join(customDownloads, 'photo.png'),
      })

      // Following normal download returns to direct save.
      const nextDirect = new FakeDownloadItem('next.mp4', 'https://example.test/next.mp4')
      expect(policy.apply(nextDirect, { id: 7 }).mode).toBe('save-path')

      // Pending Save As entries are cleared when the owning webContents is destroyed.
      policy.downloadUrlAs(
        {
          id: 7,
          downloadURL,
          once: (event, listener) => target.once(event, listener),
        },
        'https://example.test/abandoned'
      )
      target.emit('destroyed')
      const afterDestroy = new FakeDownloadItem('late.mp4', 'https://example.test/abandoned')
      expect(policy.apply(afterDestroy, { id: 7 }).mode).toBe('save-path')

      // Enabling browserAskBeforeDownload prompts for every download.
      await policy.update({
        browserDownloadDirectory: customDownloads,
        browserAskBeforeDownload: true,
      })
      const prompted = new FakeDownloadItem('ask.mp4', 'https://example.test/ask.mp4')
      expect(policy.apply(prompted, { id: 7 })).toEqual({
        mode: 'save-dialog',
        path: join(customDownloads, 'ask.mp4'),
        reason: 'ask-before-download',
      })
      expect(prompted.setSavePath).not.toHaveBeenCalled()
      expect(prompted.setSaveDialogOptions).toHaveBeenCalledExactlyOnceWith({
        defaultPath: join(customDownloads, 'ask.mp4'),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('prompts Save As instead of silently falling back to system Downloads when custom directory is unwritable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-download-unwritable-'))
    const systemDownloads = join(root, 'system')
    const blockingFile = join(root, 'not-a-directory')
    await mkdir(systemDownloads, { recursive: true })
    await writeFile(blockingFile, 'file')
    try {
      const policy = new DownloadTargetPolicy({
        defaultDownloadsDirectory: () => systemDownloads,
      })
      await policy.prepare()
      await policy.update({
        browserDownloadDirectory: join(blockingFile, 'nested'),
        browserAskBeforeDownload: false,
      })

      const item = new FakeDownloadItem('video.mp4')
      expect(policy.apply(item, { id: 2 })).toEqual({
        mode: 'save-dialog',
        path: join(systemDownloads, 'video.mp4'),
        reason: 'directory-unavailable',
      })
      expect(item.setSavePath).not.toHaveBeenCalled()
      expect(item.setSaveDialogOptions).toHaveBeenCalledExactlyOnceWith({
        defaultPath: join(systemDownloads, 'video.mp4'),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('detects runtime directory deletion and permission revocation without reusing stale cache or recreating the directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-download-runtime-loss-'))
    const systemDownloads = join(root, 'system')
    const customDownloads = join(root, 'custom')
    await mkdir(systemDownloads, { recursive: true })
    await mkdir(customDownloads, { recursive: true })
    try {
      let revoked = false
      const policy = new DownloadTargetPolicy({
        defaultDownloadsDirectory: () => systemDownloads,
        fs: {
          access: async path => {
            if (revoked && path === customDownloads) {
              throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
            }
          },
          accessSync: path => {
            if (revoked && path === customDownloads) {
              throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
            }
          },
          existsSync,
          mkdir: async path => mkdir(path, { recursive: true }),
          stat: async path => (await import('node:fs/promises')).stat(path),
          statSync: path => ({ isDirectory: () => existsSync(path) }),
        },
      })
      await policy.update({
        browserDownloadDirectory: customDownloads,
        browserAskBeforeDownload: false,
      })

      // Initial download works while directory is healthy.
      const healthy = new FakeDownloadItem('healthy.mp4')
      expect(policy.apply(healthy, { id: 5 })).toEqual({
        mode: 'save-path',
        path: join(customDownloads, 'healthy.mp4'),
      })

      // Revoking permissions at runtime immediately triggers save dialog.
      revoked = true
      const afterRevoke = new FakeDownloadItem('revoked.mp4')
      expect(policy.apply(afterRevoke, { id: 5 })).toEqual({
        mode: 'save-dialog',
        path: join(systemDownloads, 'revoked.mp4'),
        reason: 'directory-unavailable',
      })
      expect(afterRevoke.setSavePath).not.toHaveBeenCalled()

      // Restoring permissions and re-verifying recovers automatic saves.
      revoked = false
      await policy.prepare({ createMissing: false })
      const recovered = new FakeDownloadItem('recovered.mp4')
      expect(policy.apply(recovered, { id: 5 })).toEqual({
        mode: 'save-path',
        path: join(customDownloads, 'recovered.mp4'),
      })

      // Deleting the custom directory at runtime immediately prompts and does not recreate it.
      await rm(customDownloads, { recursive: true, force: true })
      const afterDelete = new FakeDownloadItem('deleted.mp4')
      expect(policy.apply(afterDelete, { id: 5 })).toEqual({
        mode: 'save-dialog',
        path: join(systemDownloads, 'deleted.mp4'),
        reason: 'directory-unavailable',
      })
      expect(afterDelete.setSavePath).not.toHaveBeenCalled()
      await policy.prepare({ createMissing: false })
      expect(existsSync(customDownloads)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('prompts instead of saving to system Downloads while a new custom directory check is pending', async () => {
    let releaseCustomCheck: (() => void) | null = null
    const customDir = '/Users/demo/CustomDownloads'
    const systemDir = '/Users/demo/Downloads'
    const policy = new DownloadTargetPolicy({
      defaultDownloadsDirectory: () => systemDir,
      fs: {
        mkdir: async path => {
          if (path === customDir) {
            await new Promise<void>(resolve => {
              releaseCustomCheck = resolve
            })
          }
        },
        access: async () => undefined,
        accessSync: () => undefined,
        existsSync: () => false,
        stat: async () => ({ isDirectory: () => true }),
        statSync: () => ({ isDirectory: () => true }),
      },
    })
    await policy.prepare()

    const pendingUpdate = policy.update({
      browserDownloadDirectory: customDir,
      browserAskBeforeDownload: false,
    })

    const duringCheck = new FakeDownloadItem('pending.mp4')
    expect(policy.apply(duringCheck, { id: 3 })).toEqual({
      mode: 'save-dialog',
      path: join(systemDir, 'pending.mp4'),
      reason: 'directory-unavailable',
    })
    expect(duringCheck.setSavePath).not.toHaveBeenCalled()

    releaseCustomCheck?.()
    await pendingUpdate

    const afterCheck = new FakeDownloadItem('ready.mp4')
    expect(policy.apply(afterCheck, { id: 3 })).toEqual({
      mode: 'save-path',
      path: join(customDir, 'ready.mp4'),
    })
  })
})
