import assert from 'node:assert/strict'
import test from 'node:test'
import { openEnvironmentInfo } from '../e2e/desktop/scenarios/git-commit-generation.scenario.mjs'

for (const initiallyExpanded of [true, false]) {
  test(`commit checkpoint opens the environment panel when initially expanded=${initiallyExpanded}`, async () => {
    let expanded = initiallyExpanded
    let toggleCount = 0
    let panelWasAsserted = false
    const control = {
      async command(action, selector, options) {
        if (selector === '[data-testid="environment-info-button"]') {
          if (action === 'waitFor') return
          if (action === 'getAttribute') {
            assert.equal(options.value, 'aria-expanded')
            return String(expanded)
          }
          if (action === 'click') {
            expanded = !expanded
            toggleCount += 1
            return
          }
        }
        assert.equal(action, 'waitFor')
        assert.equal(selector, '[data-testid="environment-info-popover"]')
        assert.equal(expanded, true, 'The checkpoint closed the environment panel')
        panelWasAsserted = true
      },
    }

    await openEnvironmentInfo(control)

    assert.equal(expanded, true)
    assert.equal(toggleCount, initiallyExpanded ? 0 : 1)
    assert.equal(panelWasAsserted, true)
  })
}

test('commit checkpoint rejects a toggle without its expanded state', async () => {
  const control = {
    async command(action) {
      assert.notEqual(action, 'click', 'Unknown panel state must not trigger a toggle')
      return undefined
    },
  }
  await assert.rejects(openEnvironmentInfo(control), /Environment toggle must expose its state/)
})
