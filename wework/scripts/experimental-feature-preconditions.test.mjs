// @vitest-environment node

import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { ensureExperimentalFeaturesEnabled } from '../e2e/desktop/modules/preferences-automation-flows.mjs'
import { setExperimentalFeatures } from '../e2e/desktop/modules/harness-app-fixture.mjs'

const TOGGLE_TEST_ID = 'general-experimental-features-toggle'
const TOGGLE = `[data-testid="${TOGGLE_TEST_ID}"]`

function createControl({ settingsVisible, enabled = false }) {
  const control = {
    readyCount: 1,
    profile: { experimentalFeaturesEnabled: enabled },
    toggles: 0,
    writes: [],
    command: vi.fn(async (action, selector, options) => {
      if (action === 'getElementCount') return String(settingsVisible ? 1 : 0)
      if (action === 'setAppPreferences') {
        assert.equal(selector, 'body')
        Object.assign(control.profile, JSON.parse(options.value))
        control.writes.push(control.profile)
        return
      }
      if (action === 'snapshot') return JSON.stringify({ testIds: [TOGGLE_TEST_ID] })
      if (action === 'getAttribute') {
        assert.equal(selector, TOGGLE)
        assert.equal(options.value, 'aria-checked')
        return String(control.profile.experimentalFeaturesEnabled)
      }
      if (action === 'click' && selector === TOGGLE) {
        control.profile.experimentalFeaturesEnabled = !control.profile.experimentalFeaturesEnabled
        control.toggles += 1
        return
      }
      if (action === 'click') {
        assert.ok(
          [
            '[data-testid="settings-button"]',
            '[data-testid="settings-menu-button"]',
            '[data-testid="settings-back-button"]',
          ].includes(selector)
        )
        return
      }
      assert.ok(['waitFor', 'scrollIntoView'].includes(action), `Unexpected action ${action}`)
    }),
  }
  return control
}

test('enables a restarted app with a new profile through the retained controller', async () => {
  const control = createControl({ settingsVisible: false })
  await ensureExperimentalFeaturesEnabled(control)
  assert.equal(control.profile.experimentalFeaturesEnabled, true)

  control.readyCount += 1
  control.profile = { experimentalFeaturesEnabled: false }
  await ensureExperimentalFeaturesEnabled(control)

  assert.equal(control.profile.experimentalFeaturesEnabled, true)
  assert.equal(
    control.command.mock.calls.filter(([action]) => action === 'setAppPreferences').length,
    2
  )
  assert.equal(control.writes.length, 2)
  assert.notEqual(control.writes[0], control.writes[1])
})

test('rechecks a preference changed externally in the same renderer', async () => {
  const control = createControl({ settingsVisible: true })
  await ensureExperimentalFeaturesEnabled(control)
  assert.equal(control.profile.experimentalFeaturesEnabled, true)

  control.profile.experimentalFeaturesEnabled = false
  await ensureExperimentalFeaturesEnabled(control)

  assert.equal(control.readyCount, 1)
  assert.equal(control.profile.experimentalFeaturesEnabled, true)
  assert.equal(control.toggles, 2)
})

test('reads a matching live preference again without toggling it', async () => {
  const control = createControl({ settingsVisible: true, enabled: true })

  await ensureExperimentalFeaturesEnabled(control)
  await ensureExperimentalFeaturesEnabled(control)

  assert.equal(control.profile.experimentalFeaturesEnabled, true)
  assert.equal(control.toggles, 0)
  assert.equal(control.command.mock.calls.filter(([action]) => action === 'getAttribute').length, 2)
})

test('does not leave Settings after the optimistic toggle changes until its save finishes', async () => {
  let checked = true
  let saving = false
  let returned = false
  let completeSaving
  const saved = new Promise(resolve => {
    completeSaving = () => {
      saving = false
      resolve()
    }
  })
  const control = {
    async command(action, selector, options) {
      if (action === 'navigate') return
      if (action === 'getAttribute') return String(checked)
      if (action === 'click') {
        checked = false
        saving = true
        return
      }
      assert.equal(action, 'waitFor')
      if (options.enabled && saving) await saved
    },
  }
  const applying = setExperimentalFeatures(control, false, 10000).then(() => {
    returned = true
  })
  await new Promise(resolve => setImmediate(resolve))
  try {
    assert.equal(checked, false)
    assert.equal(
      returned,
      false,
      'The dependent Applications assertion ran before preference persistence'
    )
  } finally {
    completeSaving()
  }
  await applying
  assert.equal(returned, true)
})
