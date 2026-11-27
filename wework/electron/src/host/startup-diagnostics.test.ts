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
        source: 'host-startup',
        stage: 'core-dsh',
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
    expect(diagnostics).toContain('Source: host-startup')
    expect(diagnostics).toContain('Stage: core-dsh')
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

  test('includes every current startup source before selecting rotated logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-startup-diagnostics-'))
    roots.push(root)
    const currentNames = [
      'wework-main.log',
      'renderer-startup.log',
      'executor.log',
      'dsh-core-runtime.log',
      'app-update.log',
    ]
    for (const name of currentNames) await writeFile(join(root, name), `${name}-current\n`)
    const bootstrapPath = join(root, 'wework-startup-bootstrap.log')
    await writeFile(bootstrapPath, 'bootstrap-current\n')
    for (let index = 1; index <= 12; index += 1) {
      await writeFile(join(root, `wework-main.log.${index}`), 'rotated-main\n')
      await writeFile(join(root, `executor.log.${index}`), 'rotated-executor\n')
    }

    const diagnostics = await buildStartupDiagnostics({
      appName: 'Wework',
      appVersion: '0.0.0',
      platform: 'win32',
      arch: 'x64',
      nodeVersion: '24.0.0',
      logDirectories: [root],
      extraLogPaths: [bootstrapPath],
      progress: { current: null, history: [] },
      failure: null,
      maxLogFiles: 6,
    })

    for (const name of currentNames) expect(diagnostics).toContain(`${name}-current`)
    expect(diagnostics).toContain('bootstrap-current')
    expect(diagnostics).not.toContain('rotated-main')
    expect(diagnostics).not.toContain('rotated-executor')
  })

  test('finds the first error between the old head window and the included tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-startup-diagnostics-'))
    roots.push(root)
    await writeFile(
      join(root, 'dsh-core-runtime.log'),
      `${'startup noise\n'.repeat(6_000)}fatal: middle startup error api_key=middle-secret\n${'later noise\n'.repeat(6_000)}latest-tail-marker\n`
    )

    const diagnostics = await buildStartupDiagnostics({
      appName: 'Wework',
      appVersion: '0.0.0',
      platform: 'win32',
      arch: 'x64',
      nodeVersion: '24.0.0',
      logDirectories: [root],
      progress: { current: null, history: [] },
      failure: null,
      maxLogTailBytes: 256,
    })

    expect(diagnostics).toContain(
      '[first error before the included tail] fatal: middle startup error'
    )
    expect(diagnostics).toContain('dsh-core-runtime.log: fatal: middle startup error')
    expect(diagnostics).toContain('latest-tail-marker')
    expect(diagnostics).not.toContain('middle-secret')
  })

  test('reports a bounded first-error scan without dropping the recent tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-startup-diagnostics-'))
    roots.push(root)
    await writeFile(
      join(root, 'wework-main.log'),
      `${'startup noise\n'.repeat(100)}fatal: outside scan budget\n${'later noise\n'.repeat(100)}latest-tail-marker\n`
    )

    const diagnostics = await buildStartupDiagnostics({
      appName: 'Wework',
      appVersion: '0.0.0',
      platform: 'win32',
      arch: 'x64',
      nodeVersion: '24.0.0',
      logDirectories: [root],
      progress: { current: null, history: [] },
      failure: null,
      maxLogTailBytes: 128,
      maxLogScanBytes: 256,
    })

    expect(diagnostics).toContain('first-error scan limited to 256 B')
    expect(diagnostics).toContain('latest-tail-marker')
    expect(diagnostics).not.toContain('outside scan budget')
  })

  test.each([
    { offset: 64 * 1024 - 1, error: 'fatal: chunk boundary error' },
    { offset: 64 * 1024 - 8, error: 'fatal: 启动失败 at chunk boundary' },
  ])('keeps a complete error line across scan chunks ($offset)', async ({ offset, error }) => {
    const root = await mkdtemp(join(tmpdir(), 'wework-startup-diagnostics-'))
    roots.push(root)
    await writeFile(
      join(root, 'wework-main.log'),
      `${'x'.repeat(offset - 1)}\n${error}\n${'later noise\n'.repeat(100)}latest-tail-marker\n`
    )

    const diagnostics = await buildStartupDiagnostics({
      appName: 'Wework',
      appVersion: '0.0.0',
      platform: 'win32',
      arch: 'x64',
      nodeVersion: '24.0.0',
      logDirectories: [root],
      progress: { current: null, history: [] },
      failure: null,
      maxLogTailBytes: 128,
    })

    expect(diagnostics).toContain(`[first error before the included tail] ${error}`)
    expect(diagnostics).toContain('latest-tail-marker')
    expect(diagnostics).not.toContain('�')
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
