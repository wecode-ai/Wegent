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

class InitialCatalogControl {
  constructor() {
    this.loaded = false
    this.advanced = false
    this.advancedClicks = 0
    this.waitStarted = new Promise(resolve => {
      this.startWait = resolve
    })
    this.catalog = new Promise((resolve, reject) => {
      this.completeCatalog = () => {
        this.loaded = true
        resolve()
      }
      this.failCatalog = reject
    })
  }

  async command(name, selector, options) {
    if (name === 'snapshot') {
      return JSON.stringify({
        testIds: [
          'model-selector-menu',
          ...(this.loaded
            ? ['model-advanced-toggle', MODEL_OPTION_ID]
            : ['model-selector-empty-state']),
        ],
      })
    }
    if (name === 'waitFor') {
      expect(selector).toBe('[data-testid="model-selector-empty-state"]')
      expect(options).toEqual({ visible: false, timeoutMs: 10_000 })
      this.startWait()
      await this.catalog
    }
    if (name === 'clickWhenEnabled' && selector.includes('model-advanced-toggle')) {
      expect(this.loaded).toBe(true)
      this.advancedClicks += 1
      this.advanced = true
    }
    if (name === 'getElementCount') {
      return this.loaded && this.advanced ? '1' : '0'
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

  test('waits for the initial catalog before opening its mounted advanced options', async () => {
    const control = new InitialCatalogControl()
    const selection = ensureModelOptionVisible(
      control,
      MODEL_OPTION_ID,
      '[data-testid="model-selector-button"]',
      EXPECTED_PROVIDER_ID
    )

    await control.waitStarted
    expect(control.advancedClicks).toBe(0)
    control.completeCatalog()
    const menu = await selection

    expect(control.advancedClicks).toBe(1)
    expect(menu.testIds).toContain(MODEL_OPTION_ID)
  })

  test('fails when the initial catalog does not arrive within the existing step timeout', async () => {
    const control = new InitialCatalogControl()
    const selection = ensureModelOptionVisible(
      control,
      MODEL_OPTION_ID,
      '[data-testid="model-selector-button"]',
      EXPECTED_PROVIDER_ID
    )
    const timeout = new Error('Timed out waiting for model-selector-empty-state to disappear')
    const rejection = expect(selection).rejects.toBe(timeout)

    await control.waitStarted
    control.failCatalog(timeout)
    await rejection
    expect(control.advancedClicks).toBe(0)
  })
})
