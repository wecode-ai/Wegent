// @vitest-environment node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'vitest'

import { runWithCheckpointResources } from '../e2e/desktop/checkpoint-scheduler.mjs'
import {
  UPGRADE_PACKAGE_CHECKPOINTS,
  UPGRADE_CHECKPOINT_GROUP,
  rejectFailedReleaseCheckpoint,
} from '../e2e/desktop/upgrade-suite.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

const checkpointExit = code =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', `process.exit(${code})`], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })

test('a failed source checkpoint group cannot produce a green verification job', async () => {
  rejectFailedReleaseCheckpoint(UPGRADE_CHECKPOINT_GROUP, await checkpointExit(0))
  await assert.rejects(
    async () => rejectFailedReleaseCheckpoint(UPGRADE_CHECKPOINT_GROUP, await checkpointExit(1)),
    { message: `Release package checkpoint failed: ${UPGRADE_CHECKPOINT_GROUP}` }
  )
})

test('a failed real child rejects the release pair before another checkpoint starts', async () => {
  const started = []
  await assert.rejects(
    runWithCheckpointResources({
      checkpoints: UPGRADE_PACKAGE_CHECKPOINTS,
      workerCount: 1,
      resourceFor: () => [],
      run: async checkpoint => {
        started.push(checkpoint)
        rejectFailedReleaseCheckpoint(checkpoint, await checkpointExit(1))
      },
    }),
    { message: `Release package checkpoint failed: ${UPGRADE_PACKAGE_CHECKPOINTS[0]}` }
  )
  assert.deepEqual(started, [UPGRADE_PACKAGE_CHECKPOINTS[0]])
})

test('a successful release pair still executes every required checkpoint', async () => {
  const completed = []
  await runWithCheckpointResources({
    checkpoints: UPGRADE_PACKAGE_CHECKPOINTS,
    workerCount: 1,
    resourceFor: () => [],
    run: async checkpoint => {
      rejectFailedReleaseCheckpoint(checkpoint, await checkpointExit(0))
      completed.push(checkpoint)
    },
  })
  assert.deepEqual(completed, UPGRADE_PACKAGE_CHECKPOINTS)
})

test('ordinary checkpoint failures retain the full diagnostic collection policy', async () => {
  const completed = []
  await runWithCheckpointResources({
    checkpoints: ['ordinary-a', 'ordinary-b'],
    workerCount: 1,
    resourceFor: () => [],
    run: async checkpoint => {
      rejectFailedReleaseCheckpoint(checkpoint, await checkpointExit(1))
      completed.push(checkpoint)
    },
  })
  assert.deepEqual(completed, ['ordinary-a', 'ordinary-b'])
})

test('terminal native input runs alone before ordinary checkpoints regain parallelism', async () => {
  const started = []
  const release = new Map()
  const checkpoints = ['ordinary-a', 'background-terminals', 'ordinary-b', 'ordinary-c']
  const pending = runWithCheckpointResources({
    checkpoints,
    workerCount: 3,
    resourceFor: () => [],
    exclusiveFor: checkpoint => checkpoint === 'background-terminals',
    run: checkpoint =>
      new Promise(resolve => {
        started.push(checkpoint)
        release.set(checkpoint, resolve)
      }),
  })

  await tick()
  assert.deepEqual(started, ['background-terminals'])
  release.get('background-terminals')()
  await tick()
  assert.deepEqual(started, ['background-terminals', 'ordinary-a', 'ordinary-b', 'ordinary-c'])
  for (const resolve of release.values()) resolve()
  await pending
  assert.equal(new Set(started).size, checkpoints.length)
})

test('multiple exclusive checkpoints never overlap with each other or shared resources', async () => {
  const active = new Set()
  const completed = []
  const exclusiveFor = checkpoint => checkpoint.startsWith('exclusive')
  await runWithCheckpointResources({
    checkpoints: ['ordinary-a', 'exclusive-a', 'ordinary-b', 'exclusive-b'],
    workerCount: 4,
    resourceFor: () => ['shared-resource'],
    exclusiveFor,
    run: async checkpoint => {
      assert.equal(active.size, 0)
      active.add(checkpoint)
      await tick()
      active.delete(checkpoint)
      completed.push(checkpoint)
    },
  })
  assert.deepEqual(completed, ['exclusive-a', 'exclusive-b', 'ordinary-a', 'ordinary-b'])
})

test('exclusive checkpoint failures propagate before ordinary work starts', async () => {
  const completed = []
  const failure = new Error('Native keyboard verification failed')
  await assert.rejects(
    runWithCheckpointResources({
      checkpoints: ['background-terminals', 'ordinary'],
      workerCount: 2,
      resourceFor: () => [],
      exclusiveFor: checkpoint => checkpoint === 'background-terminals',
      run: async checkpoint => {
        if (checkpoint === 'background-terminals') throw failure
        completed.push(checkpoint)
      },
    }),
    error => error === failure
  )
  await tick()
  assert.deepEqual(completed, [])
  await runWithCheckpointResources({
    checkpoints: ['ordinary'],
    workerCount: 1,
    resourceFor: () => [],
    run: async checkpoint => completed.push(checkpoint),
  })
  assert.deepEqual(completed, ['ordinary'])
})
