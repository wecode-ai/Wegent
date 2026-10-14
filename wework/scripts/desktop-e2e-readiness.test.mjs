import assert from 'node:assert/strict'
import test from 'node:test'

import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'

function controller() {
  return Object.assign(Object.create(DesktopE2EServer.prototype), {
    readyCount: 1,
    readyWaiters: [],
    fatalErrorPromise: new Promise(() => {}),
  })
}

test('missing desktop readiness fails within its startup budget and removes the waiter', async () => {
  const server = controller()
  await assert.rejects(server.awaitReadyAfter(1, 10), /Timed out waiting for desktop readiness/)
  assert.equal(server.readyWaiters.length, 0)
})

test('a new desktop readiness event completes the pending startup wait', async () => {
  const server = controller()
  const pending = server.awaitReadyAfter(1, 1000)
  const ready = { windowLabel: 'plugin-development-test' }
  server.readyCount += 1
  server.readyWaiters[0].resolve(ready)
  assert.equal(await pending, ready)
  assert.equal(server.readyWaiters.length, 0)
})

test('desktop readiness that arrived before the wait is returned immediately', async () => {
  const server = controller()
  server.readyCount = 2
  server.ready = { windowLabel: 'main' }
  assert.equal(await server.awaitReadyAfter(1, 10), server.ready)
})
