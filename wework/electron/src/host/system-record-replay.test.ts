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
    const recording = await recorder.stop()

    expect(recording.steps.length).toBeGreaterThanOrEqual(2)
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
    await vi.waitFor(async () => expect((await recorder.status()).phase).toBe('idle'))

    await root.remove()
  })

  test('reports unsupported platforms without starting a helper', async () => {
    const root = await temporaryDirectory('system-record-replay-')
    const recorder = new SystemRecordReplay(root.path, fixture, 'linux')

    expect(await recorder.status()).toMatchObject({ supported: false })
    await expect(recorder.start('Unsupported')).rejects.toThrow('supported on macOS')

    await root.remove()
  })
})
