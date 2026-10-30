import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { STARTUP_PROGRESS_STAGES, type StartupProgressUpdate } from './startup-progress.js'
import { buildStartupDiagnostics } from './startup-diagnostics.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('startup diagnostics', () => {
  test('includes the stage timeline, failure stack, environment and log tails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-startup-diagnostics-'))
    roots.push(root)
    const logDirectory = join(root, 'logs')
    const bootstrapDirectory = join(root, 'bootstrap')
    await mkdir(logDirectory)
    await mkdir(bootstrapDirectory)
    const bootstrapPath = join(bootstrapDirectory, 'wework-startup-bootstrap.log')
    await writeFile(join(logDirectory, 'wework-main.log'), 'main log tail\n')
    await writeFile(
      bootstrapPath,
      'migration failed api_key=super-secret-value\napi_key=another-secret\n'
    )

    const history = [
      progressUpdate(STARTUP_PROGRESS_STAGES[0], 0, 1_000),
      progressUpdate(STARTUP_PROGRESS_STAGES[2], 2, 1_800),
    ]
    const diagnostics = await buildStartupDiagnostics({
      appName: 'Wework',
      appVersion: '0.5.13-beta.5',
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.22631',
      electronVersion: '43.0.0',
      nodeVersion: '24.17.0',
      logDirectories: [logDirectory],
      extraLogPaths: [bootstrapPath],
      progress: {
        current: history[1],
        history,
      },
      failure: {
        message: 'DSH startup timed out',
        stack: 'Error: DSH startup timed out\n    at start (dsh-runtime.ts:42:11)',
      },
      runtimeError: 'DSH startup timed out',
      runtimeState: { coreDshPid: null },
      now: () => 5_000,
      maxLogTailBytes: 128,
    })

    expect(diagnostics).toContain('Wework 0.5.13-beta.5')
    expect(diagnostics).toContain('Platform: win32 x64 (10.0.22631)')
    expect(diagnostics).toContain('Startup failed: DSH startup timed out')
    expect(diagnostics).toContain('[Recent error lines]')
    expect(diagnostics).toContain('wework-startup-bootstrap.log: ')
    expect(diagnostics).toContain('migration failed')
    expect(diagnostics).toContain('+0.0s  launch')
    expect(diagnostics).toContain('components')
    expect(diagnostics).toContain('DSH startup timed out')
    expect(diagnostics).toContain('dsh-runtime.ts:42:11')
    expect(diagnostics).toContain('wework-main.log')
    expect(diagnostics).toContain('wework-startup-bootstrap.log')
    expect(diagnostics).toContain('"coreDshPid": null')
    expect(diagnostics).toContain('[REDACTED]')
    expect(diagnostics).not.toContain('super-secret-value')
    expect(diagnostics).not.toContain('another-secret')
  })

  test('bounds the number of log files included in the bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-startup-diagnostics-'))
    roots.push(root)
    const logDirectory = join(root, 'logs')
    await mkdir(logDirectory)
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(logDirectory, `file-${index}.log`), `tail-${index}\n`)
    }

    const diagnostics = await buildStartupDiagnostics({
      appName: 'Wework',
      appVersion: '0.0.0',
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '24.0.0',
      logDirectories: [logDirectory],
      progress: { current: null, history: [] },
      failure: null,
      maxLogFiles: 2,
    })

    expect(diagnostics.match(/--- file-/g)).toHaveLength(2)
  })

  test('keeps the first error line when a log is larger than the included tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-startup-diagnostics-'))
    roots.push(root)
    const logDirectory = join(root, 'logs')
    await mkdir(logDirectory)
    const filler = Array.from(
      { length: 400 },
      (_, index) => `noise ${index} ${'x'.repeat(40)}`
    ).join('\n')
    await writeFile(
      join(logDirectory, 'wework-main.log'),
      `fatal: first startup error\n${filler}\nlatest-tail-marker\n`
    )

    const diagnostics = await buildStartupDiagnostics({
      appName: 'Wework',
      appVersion: '0.0.0',
      platform: 'win32',
      arch: 'x64',
      nodeVersion: '24.0.0',
      logDirectories: [logDirectory],
      progress: { current: null, history: [] },
      failure: null,
      maxLogTailBytes: 256,
    })

    expect(diagnostics).toContain(
      '[first error before the included tail] fatal: first startup error'
    )
    expect(diagnostics).toContain('wework-main.log: fatal: first startup error')
    expect(diagnostics).toContain('latest-tail-marker')
    expect(diagnostics).not.toContain('noise 0 ')
  })

  test('keeps priority logs when the file budget is exhausted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-startup-diagnostics-'))
    roots.push(root)
    const logDirectory = join(root, 'logs')
    await mkdir(logDirectory)
    await writeFile(join(logDirectory, 'wework-main.log'), 'main-tail\n')
    await writeFile(join(logDirectory, 'app-update.log'), 'update-tail\n')
    for (let index = 0; index < 4; index += 1) {
      await writeFile(join(logDirectory, `noise-${index}.log`), `noise-${index}\n`)
    }

    const diagnostics = await buildStartupDiagnostics({
      appName: 'Wework',
      appVersion: '0.0.0',
      platform: 'win32',
      arch: 'x64',
      nodeVersion: '24.0.0',
      logDirectories: [logDirectory],
      progress: { current: null, history: [] },
      failure: null,
      maxLogFiles: 2,
    })

    expect(diagnostics).toContain('wework-main.log')
    expect(diagnostics).toContain('app-update.log')
    expect(diagnostics).not.toContain('noise-0.log')
  })
})

function progressUpdate(
  stage: (typeof STARTUP_PROGRESS_STAGES)[number],
  index: number,
  startedAt: number
): StartupProgressUpdate {
  return {
    index,
    total: STARTUP_PROGRESS_STAGES.length,
    completedWeight: STARTUP_PROGRESS_STAGES.slice(0, index).reduce(
      (total, candidate) => total + candidate.weight,
      0
    ),
    stage,
    startedAt,
  }
}
