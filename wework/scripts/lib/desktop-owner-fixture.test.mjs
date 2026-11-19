import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bindDesktopOwner,
  desktopOwnerId,
  desktopOwnerPrimaryTaskId,
  desktopOwnerCoordinatorTaskId,
  getDesktopOwner,
} from '../../e2e/desktop/modules/desktop-owner-fixture.mjs'
import {
  STORY_USER,
  STORY_PRIMARY,
} from '../../e2e/desktop/modules/stand-in-source-story-evidence.mjs'
import { createDesktopScenario } from '../../e2e/desktop/scenarios/coordination-history.scenario.mjs'

test('fixtures loaded before authentication use the actual Backend identity after binding', () => {
  assert.throws(getDesktopOwner, /must be bound/)
  bindDesktopOwner({ id: 37, user_name: 'real-owner', access_token: 'never-retain' })
  assert.equal(desktopOwnerId, 37)
  assert.equal(STORY_USER, 37)
  assert.equal(STORY_PRIMARY, 'stand-in-chat-37-primary')
  assert.equal(desktopOwnerPrimaryTaskId, STORY_PRIMARY)
  assert.equal(desktopOwnerCoordinatorTaskId, 'stand-in-coordinator-37')
  assert.deepEqual(getDesktopOwner(), { id: 37, user_name: 'real-owner' })
  for (const id of [undefined, null, 0, -1, '37', 1.5]) {
    assert.throws(() => bindDesktopOwner({ id }), /Invalid Backend owner ID/)
    assert.equal(desktopOwnerId, 37)
  }
})

test('scheduler history regression uses the bound Backend owner before accessing runtime state', async () => {
  bindDesktopOwner({ id: 47, user_name: 'history-owner' })
  const requests = []
  const control = {
    async command(action, _selector, options) {
      if (action === 'getLocationOrigin') return 'http://fixture.invalid'
      assert.equal(action, 'fetchLocalRuntime')
      const request = JSON.parse(JSON.parse(options.value).body)
      requests.push(request)
      return JSON.stringify({
        status: 200,
        headers: {},
        body: JSON.stringify({ ok: false, error: { message: 'stop-after-owner-probe' } }),
      })
    },
  }

  await assert.rejects(
    createDesktopScenario({ uiTimeoutMs: 1000 }).verify(control),
    /stop-after-owner-probe/
  )
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'runtime.stand_in.personal.get')
  assert.deepEqual(requests[0].params, { userId: 47 })
})
