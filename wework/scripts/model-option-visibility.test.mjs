import { describe, expect, test } from 'vitest'
import { ensureModelOptionVisible } from '../e2e/desktop/modules/shared.mjs'

const MODEL_OPTION_ID = 'model-option-gpt-5.6-luna'
const EXPECTED_PROVIDER_ID = 'wework-e2e'

class DeferredLocalModelControl {
  constructor() {
    this.localModelReloads = 0
    this.providerQualifiedLookupsBeforeReload = 0
  }

  async command(name, selector) {
    if (name === 'snapshot') {
      return JSON.stringify({
        testIds: ['model-selector-menu', MODEL_OPTION_ID],
      })
    }
    if (name === 'getElementCount') {
      if (selector.includes(`[data-model-provider-id="${EXPECTED_PROVIDER_ID}"]`)) {
        if (this.localModelReloads === 0) {
          this.providerQualifiedLookupsBeforeReload += 1
          return '0'
        }
        return '1'
      }
      return '1'
    }
    if (name === 'dispatchLocalModelSettingsChanged') {
      this.localModelReloads += 1
    }
    return ''
  }
}

describe('ensureModelOptionVisible', () => {
  test('reloads once instead of accepting the same model id from the wrong provider', async () => {
    const control = new DeferredLocalModelControl()

    const menu = await ensureModelOptionVisible(
      control,
      MODEL_OPTION_ID,
      '[data-testid="model-selector-button"]',
      EXPECTED_PROVIDER_ID
    )

    expect(control.providerQualifiedLookupsBeforeReload).toBeGreaterThan(0)
    expect(control.localModelReloads).toBe(1)
    expect(menu.testIds).toContain(MODEL_OPTION_ID)
  })
})
