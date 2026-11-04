import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureExperimentalFeaturesEnabled } from '../e2e/desktop/modules/preferences-automation-flows.mjs'

test('reestablishes experimental preferences after switching to a new device profile', async () => {
  let profile = { experimentalFeaturesEnabled: false }
  const writes = []
  const control = {
    async command(action, selector, options) {
      if (action === 'getElementCount') return '0'
      assert.equal(action, 'setAppPreferences')
      assert.equal(selector, 'body')
      Object.assign(profile, JSON.parse(options.value))
      writes.push(profile)
    },
  }
  await ensureExperimentalFeaturesEnabled(control)
  assert.equal(profile.experimentalFeaturesEnabled, true)

  profile = { experimentalFeaturesEnabled: false }
  await ensureExperimentalFeaturesEnabled(control)
  assert.equal(profile.experimentalFeaturesEnabled, true)
  assert.equal(writes.length, 2)
  assert.notEqual(writes[0], writes[1])
})
