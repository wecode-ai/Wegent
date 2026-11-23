import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  test('saves directly to system Downloads with disk and concurrent deduplication', async () => {
    const downloadsDir = await mkdtemp(join(tmpdir(), 'wework-download-policy-'))
    const onDownloadCompleted = vi.fn()
    try {
      await writeFile(join(downloadsDir, 'video.mp4'), 'existing')
      const policy = new DownloadTargetPolicy({
        defaultDownloadsDirectory: () => downloadsDir,
        onDownloadCompleted,
      })

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
      policy.update({
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
      const downloadURL = vi.fn()
      policy.downloadUrlAs({ id: 7, downloadURL }, 'https://example.test/start#hash')
      expect(downloadURL).toHaveBeenCalledExactlyOnceWith('https://example.test/start#hash')
      const saveAsItem = new FakeDownloadItem('photo.png', 'https://cdn.example.test/final.png', [
        'https://example.test/start',
        'https://cdn.example.test/final.png',
      ])
      expect(policy.apply(saveAsItem, { id: 7 })).toEqual({
        mode: 'save-dialog',
        path: join(customDownloads, 'photo.png'),
      })
      expect(saveAsItem.setSavePath).not.toHaveBeenCalled()
      expect(saveAsItem.setSaveDialogOptions).toHaveBeenCalledExactlyOnceWith({
        defaultPath: join(customDownloads, 'photo.png'),
      })

      // Following normal download returns to direct save.
      const nextDirect = new FakeDownloadItem('next.mp4', 'https://example.test/next.mp4')
      expect(policy.apply(nextDirect, { id: 7 }).mode).toBe('save-path')

      // Enabling browserAskBeforeDownload prompts for every download.
      policy.update({
        browserDownloadDirectory: customDownloads,
        browserAskBeforeDownload: true,
      })
      const prompted = new FakeDownloadItem('ask.mp4', 'https://example.test/ask.mp4')
      expect(policy.apply(prompted, { id: 7 })).toEqual({
        mode: 'save-dialog',
        path: join(customDownloads, 'ask.mp4'),
      })
      expect(prompted.setSavePath).not.toHaveBeenCalled()
      expect(prompted.setSaveDialogOptions).toHaveBeenCalledExactlyOnceWith({
        defaultPath: join(customDownloads, 'ask.mp4'),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('falls back to save dialog when no download directory is writable', () => {
    const warnings: string[] = []
    const policy = new DownloadTargetPolicy({
      defaultDownloadsDirectory: () => '/Users/demo/Downloads',
      onDirectoryWarning: message => warnings.push(message),
      fs: {
        mkdirSync: () => undefined,
        accessSync: () => {
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        },
        existsSync: () => false,
      },
    })
    policy.update({ browserDownloadDirectory: '/Volumes/Missing', browserAskBeforeDownload: false })

    const item = new FakeDownloadItem('video.mp4')
    expect(policy.apply(item, { id: 2 })).toEqual({
      mode: 'save-dialog',
      path: join('/Users/demo/Downloads', 'video.mp4'),
    })
    expect(item.setSavePath).not.toHaveBeenCalled()
    expect(item.setSaveDialogOptions).toHaveBeenCalledExactlyOnceWith({
      defaultPath: join('/Users/demo/Downloads', 'video.mp4'),
    })
    expect(warnings).toHaveLength(2)
  })
})
