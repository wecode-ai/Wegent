import assert from 'node:assert/strict'
import test from 'node:test'
import { restartCloudConfigDesktop } from '../e2e/desktop/modules/cloud-config-restart-readiness.mjs'

test('a reconnected controller cannot pass cold restart readiness before the native handoff closes', async () => {
  const calls = []
  let resolveClosed
  let observedPending
  const observing = new Promise(resolve => {
    observedPending = resolve
  })
  const closed = new Promise(resolve => {
    resolveClosed = resolve
  })
  const options = { forceStop: true }
  const restart = async value => calls.push(['restart', value])
  const control = {
    async command(...args) {
      calls.push(args)
      if (calls.length === 2) return JSON.stringify({ state: 'completing' })
      observedPending()
      return closed
    },
  }
  let completed = false
  const ready = restartCloudConfigDesktop(control, restart, 60_000, options).then(value => {
    completed = true
    return value
  })

  await observing
  assert.equal(completed, false)
  assert.deepEqual(calls[0], ['restart', options])
  for (const call of calls.slice(1)) {
    assert.deepEqual(call, ['getStartupSplashSnapshot', 'body', { timeoutMs: 60_000 }])
  }
  resolveClosed(JSON.stringify({ state: 'closed' }))
  assert.deepEqual(await ready, { state: 'closed' })
})

test('restart failures propagate without issuing a readiness observation', async () => {
  const failure = new Error('Desktop restart failed')
  let reads = 0
  await assert.rejects(
    restartCloudConfigDesktop(
      { command: async () => reads++ },
      async () => {
        throw failure
      },
      60_000
    ),
    failure
  )
  assert.equal(reads, 0)
})

test('a startup observation failure propagates without retrying the restart', async () => {
  const failure = new Error('Startup state is unavailable')
  let restarts = 0
  let reads = 0
  await assert.rejects(
    restartCloudConfigDesktop(
      {
        async command() {
          reads++
          throw failure
        },
      },
      async () => restarts++,
      60_000
    ),
    failure
  )
  assert.equal(restarts, 1)
  assert.equal(reads, 1)
})
