import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  sourcePreparationProgress,
  waitForSourcePreparation,
} from '../e2e/desktop/modules/source-preparation-progress.mjs'

const event = (
  stage,
  { version = 'source', releaseId = 'source-preparation', phase = 'started' } = {}
) =>
  `2026-11-02T00:00:00.000Z [supervisor] ${JSON.stringify({ event: 'release-preparation-stage', version, releaseId, stage, phase })}\n`

test('reads only complete preparation stages for the selected source', () => {
  const log =
    event('macos-installation', { version: 'previous' }) +
    event('profile-copy') +
    event('components') +
    event('runtimes') +
    event('macos-installation', { releaseId: 'candidate' }) +
    event('profile-prepare').trimEnd()
  assert.deepEqual(sourcePreparationProgress(log, 'source'), { phase: 'runtimes' })
  assert.deepEqual(sourcePreparationProgress(log + '\n', 'source'), { phase: 'profile-prepare' })
})

test('rejects backwards stages within one log read', () => {
  assert.throws(
    () => sourcePreparationProgress(event('runtimes') + event('components'), 'source'),
    /regressed/
  )
})

test('allows total preparation beyond one budget while bounding every phase', async () => {
  let complete
  const preparation = new Promise(resolve => {
    complete = resolve
  })
  const stages = [
    'profile-copy',
    'components',
    'runtimes',
    'runtimes',
    'profile-prepare',
    'profile-prepare',
  ]
  let time = 0
  let stopped = false
  const result = await waitForSourcePreparation(
    preparation,
    async () => ({ phase: stages.shift() }),
    {
      now: () => time,
      sleep: async () => {
        time += 100_000
        if (stages.length === 0) complete('prepared')
      },
      stop: async () => {
        stopped = true
      },
    }
  )
  assert.ok(time > 300_000)
  assert.equal(result, 'prepared')
  assert.equal(stopped, false)
})

test('keeps the last phase bounded until the process actually exits', async () => {
  let reject
  const preparation = new Promise((_, fail) => {
    reject = fail
  })
  preparation.child = { pid: 1 }
  let time = 0
  let stops = 0
  await assert.rejects(
    waitForSourcePreparation(preparation, async () => ({ phase: 'profile-prepare' }), {
      now: () => time,
      sleep: async () => {
        time += 100_000
      },
      stop: async child => {
        assert.equal(child, preparation.child)
        stops++
        reject(new Error('stopped'))
      },
    }),
    /phase=profile-prepare, elapsedMs=300000/
  )
  assert.equal(stops, 1)
})

test('preserves the original source process failure', async () => {
  const original = new Error('source preparation failed with original stderr')
  const preparation = Promise.reject(original)
  await assert.rejects(
    waitForSourcePreparation(preparation, async () => ({ phase: 'profile-prepare' })),
    error => error === original
  )
})
