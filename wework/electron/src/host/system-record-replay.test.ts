import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { temporaryDirectory } from '../runtime/test-helpers.js'
import { SystemRecordReplay } from './system-record-replay.js'

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'system-record-replay-fixture.mjs'
)

describe('system record replay', () => {
  test('records global operation steps and persists a local recording', async () => {
    const root = await temporaryDirectory('system-record-replay-')
    const recorder = new SystemRecordReplay(root.path, fixture, 'darwin')

    expect(await recorder.status()).toMatchObject({
      supported: true,
      accessibilityGranted: true,
      inputMonitoringGranted: true,
    })
    await recorder.start('Desktop flow')
    await vi.waitFor(async () =>
      expect((await recorder.status()).stepCount).toBeGreaterThanOrEqual(2)
    )
    const recording = await recorder.stop(2)

    expect(recording.steps).toHaveLength(2)
    expect(recording.steps[0]).toMatchObject({
      type: 'mouse',
      appName: 'Finder',
      appBundleId: 'com.apple.finder',
    })
    expect(await recorder.list()).toMatchObject([
      {
        title: 'Desktop flow',
        applicationCount: 2,
        containsHandoff: false,
      },
    ])
    const persisted = JSON.parse(
      await readFile(join(root.path, 'system-recordings', 'recordings.json'), 'utf8')
    )
    expect(persisted.recordings).toHaveLength(1)
    await root.remove()
  })

  test('replays captured system operations in order', async () => {
    const root = await temporaryDirectory('system-record-replay-')
    const recorder = new SystemRecordReplay(root.path, fixture, 'darwin')
    await recorder.start('Replay flow')
    await vi.waitFor(async () => expect((await recorder.status()).stepCount).toBeGreaterThan(0))
    const recording = await recorder.stop()

    await recorder.replay(recording.id)
    await vi.waitFor(async () => expect((await recorder.status()).phase).toBe('idle'), {
      timeout: 15_000,
    })

    await root.remove()
  })

  test('keeps recording after a post-ready helper diagnostic', async () => {
    const root = await temporaryDirectory('system-record-replay-')
    process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_STDERR = 'after-ready'
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const recorder = new SystemRecordReplay(root.path, fixture, 'darwin')
      await recorder.start('Noisy recording')
      await vi.waitFor(async () =>
        expect((await recorder.status()).stepCount).toBeGreaterThanOrEqual(1)
      )

      expect(await recorder.status()).toMatchObject({ phase: 'recording' })
      await recorder.stop(1)
      expect(warning).toHaveBeenCalledWith(
        '[system-record-replay] recorder helper diagnostic',
        'non-fatal recorder diagnostic'
      )
    } finally {
      warning.mockRestore()
      delete process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_STDERR
      await root.remove()
    }
  })

  test('times out a helper operation', async () => {
    const root = await temporaryDirectory('system-record-replay-')
    process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_HANG = 'status'
    try {
      const recorder = new SystemRecordReplay(root.path, fixture, 'darwin', {
        operationTimeoutMs: 50,
      })
      await expect(recorder.status()).rejects.toThrow("command 'status' timed out")
    } finally {
      delete process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_HANG
      await root.remove()
    }
  })

  test('terminates an in-flight replay when cancelled', async () => {
    const root = await temporaryDirectory('system-record-replay-')
    const startedFile = join(root.path, 'helper-started')
    const recorder = new SystemRecordReplay(root.path, fixture, 'darwin')
    await recorder.start('Cancelled replay')
    await vi.waitFor(async () => expect((await recorder.status()).stepCount).toBeGreaterThan(0))
    const recording = await recorder.stop(1)
    process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_HANG = 'execute'
    process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_STARTED_FILE = startedFile
    try {
      await recorder.replay(recording.id)
      await vi.waitFor(async () => expect(await readFile(startedFile, 'utf8')).toBe('execute\n'))
      recorder.cancel()

      expect(await recorder.status()).toMatchObject({ phase: 'idle' })
    } finally {
      delete process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_HANG
      delete process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_STARTED_FILE
      await recorder.dispose()
      await root.remove()
    }
  })

  test('allows a new recording after replay failure', async () => {
    const root = await temporaryDirectory('system-record-replay-')
    const recorder = new SystemRecordReplay(root.path, fixture, 'darwin')
    process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_FAIL = 'execute'
    try {
      await recorder.start('Failed replay')
      await vi.waitFor(async () => expect((await recorder.status()).stepCount).toBeGreaterThan(0))
      const recording = await recorder.stop(1)
      await recorder.replay(recording.id)
      await vi.waitFor(async () => expect((await recorder.status()).phase).toBe('failed'), {
        timeout: 3_000,
      })

      delete process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_FAIL
      await expect(recorder.start('Recovered recording')).resolves.toMatchObject({
        phase: 'recording',
      })
    } finally {
      delete process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_FAIL
      await recorder.dispose()
      await root.remove()
    }
  })

  test('disposes an active helper without saving a partial recording', async () => {
    const root = await temporaryDirectory('system-record-replay-')
    const exitFile = join(root.path, 'recorder-exited')
    process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_EXIT_FILE = exitFile
    try {
      const recorder = new SystemRecordReplay(root.path, fixture, 'darwin')
      await recorder.start('Partial recording')
      await recorder.dispose()

      await vi.waitFor(async () => expect(await readFile(exitFile, 'utf8')).toBe('stopped\n'))
      expect(await recorder.list()).toEqual([])
    } finally {
      delete process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_EXIT_FILE
      await root.remove()
    }
  })

  test('reports unsupported platforms without starting a helper', async () => {
    const root = await temporaryDirectory('system-record-replay-')
    const recorder = new SystemRecordReplay(root.path, fixture, 'linux')

    expect(await recorder.status()).toMatchObject({ supported: false })
    await expect(recorder.start('Unsupported')).rejects.toThrow('supported on macOS')

    await root.remove()
  })
})
