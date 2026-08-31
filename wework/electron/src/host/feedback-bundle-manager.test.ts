import extract from 'extract-zip'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { FeedbackBundleManager } from './feedback-bundle-manager.js'

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
    const manager = createManager(root, logs)

    const preview = await manager.preview({
      includeRuntimeLogs: true,
      includeTaskInfo: true,
      includeScreenshot: true,
      includeSystemInfo: true,
      note: 'Reproduction note',
      taskContext: { task: { id: 7 }, accessToken: 'task-secret' },
      screenshotDataUrl: 'data:image/png;base64,cG5n',
      composerDiagnostics: { authorization: 'Bearer composer-secret' },
      attachments: [
        {
          name: '../notes.txt',
          mimeType: 'text/plain',
          dataBase64: Buffer.from('attachment').toString('base64'),
        },
      ],
    })

    expect(preview.reportId).toMatch(/^WF-[A-F0-9]+$/)
    expect(preview.entries.map(entry => entry.archivePath)).toEqual(
      expect.arrayContaining([
        'logs/executor/executor.log',
        'context/task.json',
        'environment.json',
        'screenshot.png',
        'attachments/1-notes.txt',
      ])
    )
    expect(JSON.stringify(preview.entries)).not.toContain('task-secret')
    const exported = await manager.confirm(preview.stagingId)
    await expect(stat(exported.path)).resolves.toMatchObject({ size: expect.any(Number) })

    const extracted = join(root, 'extracted')
    await extract(exported.path, { dir: extracted })
    const log = await readFile(join(extracted, 'logs', 'executor', 'executor.log'), 'utf8')
    expect(log).toContain('Authorization: Bearer [REDACTED]')
    expect(log).toContain('password=[REDACTED]')
    expect(log).not.toContain('top-secret')
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
})

function createManager(root: string, logs: string): FeedbackBundleManager {
  return new FeedbackBundleManager({
    appVersion: () => '1.2.3',
    cacheDirectory: join(root, 'cache'),
    downloadsDirectory: join(root, 'downloads'),
    logDirectories: [logs],
  })
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(path)
  return path
}
