import extract from 'extract-zip'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { FeedbackBundleManager, type FeedbackExportRequest } from './feedback-bundle-manager.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(
    temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))
  )
})

describe('FeedbackBundleManager', () => {
  test('previews a redacted archive and confirms it into Downloads', async () => {
    const root = await temporaryDirectory('wework-feedback-')
    const logs = join(root, 'logs')
    await mkdir(logs)
    await writeFile(
      join(logs, 'executor.log'),
      'Authorization: Bearer top-secret\npassword=hunter2\nstatus=401\n'
    )
    await writeFile(join(logs, 'executor.log.1'), 'previous plugin sync failure\n')
    const downloadsDirectory = vi.fn(() => join(root, 'downloads'))
    const manager = createManager(root, logs, downloadsDirectory)
    expect(downloadsDirectory).not.toHaveBeenCalled()

    const preview = await manager.preview({
      includeRuntimeLogs: true,
      includeTaskInfo: true,
      includeScreenshot: true,
      includeSystemInfo: true,
      note: 'Reproduction note',
      taskContext: { task: { id: 7 }, accessToken: 'task-secret' },
      screenshotDataUrl: 'data:image/png;base64,cG5n',
      composerDiagnostics: { authorization: 'Bearer composer-secret' },
      conversationDiagnostics: {
        schemaVersion: 1,
        events: [{ name: 'anchor-lost', details: { scrollerId: 1, rowIndex: 4 } }],
        accessToken: 'conversation-secret',
        detail: 'password=conversation-password',
      },
      attachments: [
        {
          name: '../notes.txt',
          mimeType: 'text/plain',
          dataBase64: Buffer.from('attachment').toString('base64'),
        },
      ],
    })
    expect(downloadsDirectory).not.toHaveBeenCalled()

    expect(preview.reportId).toMatch(/^WF-[A-F0-9]+$/)
    expect(preview.entries.map(entry => entry.archivePath)).toEqual(
      expect.arrayContaining([
        'logs/executor/executor.log',
        'logs/executor/executor.log.1',
        'logs/webview/conversation-diagnostics.json',
        'context/task.json',
        'environment.json',
        'screenshot.png',
        'attachments/1-notes.txt',
      ])
    )
    expect(JSON.stringify(preview.entries)).not.toContain('task-secret')
    expect(JSON.stringify(preview.entries)).not.toContain('conversation-secret')
    expect(JSON.stringify(preview.entries)).not.toContain('conversation-password')
    const exported = await manager.confirm(preview.stagingId)
    expect(downloadsDirectory).toHaveBeenCalledOnce()
    await expect(stat(exported.path)).resolves.toMatchObject({ size: expect.any(Number) })

    const extracted = join(root, 'extracted')
    await extract(exported.path, { dir: extracted })
    const log = await readFile(join(extracted, 'logs', 'executor', 'executor.log'), 'utf8')
    expect(log).toContain('Authorization: Bearer [REDACTED]')
    expect(log).toContain('password=[REDACTED]')
    expect(log).not.toContain('top-secret')
    const conversationDiagnostics = JSON.parse(
      await readFile(join(extracted, 'logs', 'webview', 'conversation-diagnostics.json'), 'utf8')
    )
    expect(conversationDiagnostics).toEqual({
      schemaVersion: 1,
      events: [{ name: 'anchor-lost', details: { scrollerId: 1, rowIndex: 4 } }],
      accessToken: '[REDACTED]',
      detail: 'password=[REDACTED]',
    })
    const manifest = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8')) as {
      reportId: string
      included: string[]
    }
    expect(manifest).toMatchObject({
      reportId: preview.reportId,
      included: ['runtimeLogs', 'taskInfo', 'systemInfo', 'screenshot', 'attachments'],
    })
  })

  test('discards staged bundles and rejects expired confirmation', async () => {
    const root = await temporaryDirectory('wework-feedback-discard-')
    const manager = createManager(root, join(root, 'missing-logs'))
    const preview = await manager.preview({
      includeRuntimeLogs: false,
      includeTaskInfo: false,
      includeScreenshot: false,
      includeSystemInfo: false,
      note: '',
      taskContext: null,
      screenshotDataUrl: null,
      composerDiagnostics: null,
      attachments: [],
    })

    await manager.discard(preview.stagingId)
    await expect(manager.confirm(preview.stagingId)).rejects.toThrow(
      'The prepared feedback bundle expired'
    )
  })

  test('does not include supplied conversation diagnostics when runtime logs are unselected', async () => {
    const root = await temporaryDirectory('wework-feedback-no-conversation-')
    const manager = createManager(root, join(root, 'missing-logs'))
    const preview = await manager.preview(
      createRequest({
        includeRuntimeLogs: false,
        conversationDiagnostics: { events: [{ name: 'anchor-lost' }] },
      })
    )

    expect(preview.entries.some(entry => entry.archivePath.startsWith('logs/'))).toBe(false)
    expect(preview.warnings).toEqual([])
    const exported = await manager.confirm(preview.stagingId)
    const extracted = join(root, 'extracted')
    await extract(exported.path, { dir: extracted })
    await expect(
      stat(join(extracted, 'logs', 'webview', 'conversation-diagnostics.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.each([0, 1])(
    'caps conversation diagnostics at 256 KB (overflow: %i byte)',
    async overflow => {
      const root = await temporaryDirectory('wework-feedback-conversation-cap-')
      const logs = join(root, 'logs')
      await mkdir(logs)
      const manager = createManager(root, logs)
      const limit = 256 * 1024
      const overhead = Buffer.byteLength(JSON.stringify({ padding: '' }, null, 2))
      const preview = await manager.preview(
        createRequest({
          conversationDiagnostics: { padding: 'x'.repeat(limit - overhead + overflow) },
        })
      )
      const entry = preview.entries.find(
        item => item.archivePath === 'logs/webview/conversation-diagnostics.json'
      )

      if (overflow === 0) {
        expect(entry).toMatchObject({ category: 'logs', sizeBytes: limit, truncated: true })
        expect(preview.skipped).not.toContain('runtimeLogs')
        expect(preview.warnings).toEqual([])
      } else {
        expect(entry).toBeUndefined()
        expect(preview.skipped).toContain('runtimeLogs')
        expect(preview.warnings).toEqual([
          'Conversation diagnostics exceeded 256 KB and were skipped',
        ])
      }
    }
  )

  test('measures conversation diagnostic limits in UTF-8 bytes', async () => {
    const root = await temporaryDirectory('wework-feedback-conversation-utf8-')
    const logs = join(root, 'logs')
    await mkdir(logs)
    const manager = createManager(root, logs)
    const preview = await manager.preview(
      createRequest({ conversationDiagnostics: { padding: '界'.repeat(90_000) } })
    )

    expect(
      preview.entries.find(
        item => item.archivePath === 'logs/webview/conversation-diagnostics.json'
      )
    ).toBeUndefined()
    expect(preview.warnings).toEqual(['Conversation diagnostics exceeded 256 KB and were skipped'])
  })
})

function createRequest(overrides: Partial<FeedbackExportRequest>): FeedbackExportRequest {
  return {
    includeRuntimeLogs: true,
    includeTaskInfo: false,
    includeScreenshot: false,
    includeSystemInfo: false,
    note: '',
    taskContext: null,
    screenshotDataUrl: null,
    composerDiagnostics: null,
    attachments: [],
    ...overrides,
  }
}

function createManager(
  root: string,
  logs: string,
  downloadsDirectory: () => string = () => join(root, 'downloads')
): FeedbackBundleManager {
  return new FeedbackBundleManager({
    appVersion: () => '1.2.3',
    cacheDirectory: join(root, 'cache'),
    downloadsDirectory,
    logDirectories: [logs],
  })
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(path)
  return path
}
