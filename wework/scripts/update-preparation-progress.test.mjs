import assert from 'node:assert/strict'
import { test } from 'vitest'
import { waitForUpdatePreparation } from '../e2e/desktop/modules/update-preparation-progress.mjs'

function clock() {
  let time = 0
  return {
    now: () => time,
    sleep: async () => {
      time += 100_000
    },
  }
}

test('allows independent bounded host, extraction, and runtime preparation', async () => {
  const phases = ['host', 'host', 'extracting', 'extracting', 'runtime', 'runtime', 'ready']
  const timing = clock()
  const progress = await waitForUpdatePreparation(async () => ({ phase: phases.shift() }), timing)
  assert.equal(progress.phase, 'ready')
  assert.ok(timing.now() > 300_000)
  assert.equal(phases.length, 0)
})

test('fails a stalled phase without restarting the preparation', async () => {
  let reads = 0
  await assert.rejects(
    waitForUpdatePreparation(async () => {
      reads++
      return { phase: 'runtime' }
    }, clock()),
    /phase=runtime, elapsedMs=300000/
  )
  assert.equal(reads, 4)
})

test('preserves the preparation failure', async () => {
  await assert.rejects(
    waitForUpdatePreparation(async () => ({
      phase: 'failed',
      failure: { message: 'corrupt package' },
    })),
    /corrupt package/
  )
})

test('rejects a backwards phase transition', async () => {
  const phases = ['runtime', 'extracting']
  await assert.rejects(
    waitForUpdatePreparation(async () => ({ phase: phases.shift() }), clock()),
    /phase regressed/
  )
})

test('does not erase an expired deadline when the phase advances', async () => {
  let time = 0
  const phases = ['host', 'extracting']
  await assert.rejects(
    waitForUpdatePreparation(async () => ({ phase: phases.shift() }), {
      now: () => time,
      sleep: async () => {
        time += 300_000
      },
    }),
    /phase=host, elapsedMs=300000/
  )
})
