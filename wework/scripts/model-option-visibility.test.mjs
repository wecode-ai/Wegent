import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  ensureModelOptionVisible,
  selectE2EModel,
  WORKBENCH_READY_TIMEOUT_MS,
} from '../e2e/desktop/modules/shared.mjs'

const MODEL_OPTION_ID = 'model-option-gpt-5.6-luna'
const EXPECTED_PROVIDER_ID = 'wework-e2e'
const TARGET = `[data-testid="${MODEL_OPTION_ID}"][data-model-provider-id="${EXPECTED_PROVIDER_ID}"]`
const targetModel = { id: MODEL_OPTION_ID, provider: EXPECTED_PROVIDER_ID }
const fixtures = []

function deferred() {
  let resolve
  const promise = new Promise(complete => {
    resolve = complete
  })
  return { promise, resolve }
}

function observe(promise) {
  const state = { settled: false }
  state.result = promise.then(
    value => {
      state.settled = true
      return { value }
    },
    error => {
      state.settled = true
      return { error }
    }
  )
  return state
}

function visible(element) {
  if (!element?.isConnected) return false
  for (let current = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false
  }
  return true
}

// Use DOM queries and click handlers, rather than canned command responses: the
// catalog is committed only after both independent native operations complete.
class ModelPickerControl {
  constructor({ view = 'simple', initiallyOpen = false, keepOptionsHidden = false } = {}) {
    this.dom = new JSDOM(
      '<body><button data-testid="model-selector-button">GPT-6.1 Sol</button></body>'
    )
    this.document = this.dom.window.document
    this.catalog = deferred()
    this.auth = deferred()
    this.view = view
    this.keepOptionsHidden = keepOptionsHidden
    this.models = null
    this.advancedClicks = 0
    this.button = this.document.querySelector('button')
    this.button.addEventListener('click', () => this.openMenu())
    this.ready = Promise.all([this.catalog.promise, this.auth.promise]).then(([models]) => {
      this.models = models
      this.renderCatalog()
    })
    if (initiallyOpen) this.openMenu()
    fixtures.push(this)
  }

  openMenu() {
    if (this.menu?.isConnected) return
    this.menu = this.document.createElement('div')
    this.menu.dataset.testid = 'model-selector-menu'
    this.document.body.append(this.menu)
    this.renderCatalog()
  }

  renderCatalog() {
    if (!this.menu?.isConnected || this.models === null) return
    this.menu.replaceChildren()
    this.menu.dataset.panel = this.view
    const simple = this.document.createElement('div')
    simple.hidden = this.view !== 'simple'
    const toggle = this.document.createElement('button')
    toggle.dataset.testid = 'model-advanced-toggle'
    toggle.textContent = 'GPT-6.1 Sol'
    toggle.addEventListener('click', () => {
      this.advancedClicks += 1
      this.view = 'advanced'
      this.renderCatalog()
    })
    simple.append(toggle)
    const advanced = this.document.createElement('div')
    advanced.setAttribute('aria-hidden', String(this.view !== 'advanced' || this.keepOptionsHidden))
    for (const model of this.models) {
      const option = this.document.createElement('button')
      option.dataset.testid = model.id
      if (model.provider) option.dataset.modelProviderId = model.provider
      option.textContent = DEFAULT_MODEL_LABEL
      option.addEventListener('click', () => {
        option.setAttribute('aria-checked', 'true')
        this.button.textContent = option.textContent
        this.button.dataset.modelProviderId = model.provider
      })
      advanced.append(option)
    }
    this.menu.append(simple, advanced)
  }

  async waitFor(selector, options) {
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS)
    while (Date.now() < deadline) {
      const match = [...this.document.querySelectorAll(selector)].find(
        element => (!options.visible || visible(element)) && !element.disabled
      )
      if (match) return match
      await new Promise(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())))
    }
    throw new Error(`Timed out waiting for ${options.visible ? 'visible ' : ''}${selector}`)
  }

  async command(name, selector, options = {}) {
    const element = selector ? this.document.querySelector(selector) : null
    switch (name) {
      case 'snapshot':
        return JSON.stringify({
          testIds: [...this.document.querySelectorAll('[data-testid]')].map(
            node => node.dataset.testid
          ),
        })
      case 'getElementCount':
        return String(
          [...this.document.querySelectorAll(selector)].filter(
            node => !options.visible || visible(node)
          ).length
        )
      case 'waitFor':
        return (await this.waitFor(selector, options)).textContent
      case 'click':
      case 'clickWhenEnabled':
        ;(await this.waitFor(selector, { ...options, visible: true })).click()
        return ''
      case 'getAttribute':
        return element?.getAttribute(options.value) ?? null
      case 'getText':
        return element?.textContent ?? ''
      case 'press':
        if (options.key === 'Escape') this.menu.remove()
        return ''
      case 'scrollIntoView':
        if (!element) throw new Error(`No element matched ${selector}`)
        return ''
      case 'hover':
      case 'dispatchLocalModelSettingsChanged':
        // These do not load or reveal anything in the current picker protocol.
        return ''
      default:
        throw new Error(`Unsupported control action ${name}`)
    }
  }

  complete(models = [targetModel]) {
    this.catalog.resolve(models)
    this.auth.resolve(true)
    return this.ready
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  for (const fixture of fixtures.splice(0)) fixture.dom.window.close()
})

describe('ensureModelOptionVisible', () => {
  test.each([1199, 2000])(
    'waits for the catalog and deferred auth at %ims before revealing the exact provider',
    async authDelay => {
      const control = new ModelPickerControl()
      control.catalog.resolve([targetModel])
      const operation = observe(ensureModelOptionVisible(control, MODEL_OPTION_ID))

      await vi.advanceTimersByTimeAsync(authDelay)
      expect(control.document.querySelector(TARGET)).toBeNull()
      expect(operation.settled).toBe(false)
      control.auth.resolve(true)
      await vi.advanceTimersByTimeAsync(25)

      const { value, error } = await operation.result
      expect(error).toBeUndefined()
      expect(value.testIds).toContain(MODEL_OPTION_ID)
      expect(visible(control.document.querySelector(TARGET))).toBe(true)
      expect(control.menu.dataset.panel).toBe('advanced')
    }
  )

  test('reveals a hidden advanced entry without accepting DOM presence as visibility', async () => {
    const control = new ModelPickerControl({ initiallyOpen: true })
    await control.complete()
    expect(control.document.querySelector(TARGET)).not.toBeNull()
    expect(visible(control.document.querySelector(TARGET))).toBe(false)

    await ensureModelOptionVisible(control, MODEL_OPTION_ID)

    expect(control.advancedClicks).toBe(1)
    expect(visible(control.document.querySelector(TARGET))).toBe(true)
  })

  test('keeps an already advanced picker open', async () => {
    const control = new ModelPickerControl({ view: 'advanced', initiallyOpen: true })
    await control.complete()

    await ensureModelOptionVisible(control, MODEL_OPTION_ID)

    expect(control.advancedClicks).toBe(0)
    expect(visible(control.document.querySelector(TARGET))).toBe(true)
  })

  test('waits for the expected provider even when another provider has the same model id', async () => {
    const control = new ModelPickerControl({ view: 'advanced', initiallyOpen: true })
    await control.complete([{ ...targetModel, provider: 'other-provider' }])
    const operation = observe(ensureModelOptionVisible(control, MODEL_OPTION_ID))
    await vi.advanceTimersByTimeAsync(2000)
    expect(operation.settled).toBe(false)
    expect(control.document.querySelector(TARGET)).toBeNull()

    control.models.push(targetModel)
    control.renderCatalog()
    await vi.advanceTimersByTimeAsync(25)

    expect((await operation.result).error).toBeUndefined()
    expect(visible(control.document.querySelector(TARGET))).toBe(true)
  })

  test.each([{ models: [] }, { models: [{ ...targetModel, provider: 'other-provider' }] }])(
    'rejects a permanently missing exact-provider entry with models $models',
    async ({ models }) => {
      const control = new ModelPickerControl({ view: 'advanced' })
      await control.complete(models)
      const started = Date.now()
      const operation = observe(ensureModelOptionVisible(control, MODEL_OPTION_ID))

      await vi.advanceTimersByTimeAsync(WORKBENCH_READY_TIMEOUT_MS)

      const { error } = await operation.result
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toContain(TARGET)
      expect(Date.now() - started).toBe(WORKBENCH_READY_TIMEOUT_MS)
    }
  )

  test('retains the ordinary interaction deadline when the advanced entry stays hidden', async () => {
    const control = new ModelPickerControl({ keepOptionsHidden: true })
    await control.complete()
    const started = Date.now()
    const operation = observe(ensureModelOptionVisible(control, MODEL_OPTION_ID))

    await vi.advanceTimersByTimeAsync(DEFAULT_STEP_TIMEOUT_MS)

    const { error } = await operation.result
    expect(control.menu.dataset.panel).toBe('advanced')
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain(`visible [data-testid="model-selector-menu"] ${TARGET}`)
    expect(visible(control.document.querySelector(TARGET))).toBe(false)
    expect(Date.now() - started).toBe(DEFAULT_STEP_TIMEOUT_MS)
  })

  test('accepts the available member of a model alias list', async () => {
    const control = new ModelPickerControl()
    await control.complete()

    await ensureModelOptionVisible(control, ['unavailable-alias', MODEL_OPTION_ID])

    expect(visible(control.document.querySelector(TARGET))).toBe(true)
  })

  test('reveals a cloud preset that has no Codex provider', async () => {
    const control = new ModelPickerControl()
    const presetId = 'model-option-preset-quality'
    await control.complete([{ id: presetId }])

    await ensureModelOptionVisible(control, presetId, '[data-testid="model-selector-button"]', null)

    const preset = control.document.querySelector(`[data-testid="${presetId}"]`)
    expect(visible(preset)).toBe(true)
    expect(preset.getAttribute('data-model-provider-id')).toBeNull()
  })

  test('selects and retains the exact provider through the real shared caller', async () => {
    const control = new ModelPickerControl()
    await control.complete()

    await selectE2EModel(control)

    expect(control.button.textContent).toBe(DEFAULT_MODEL_LABEL)
    expect(control.button.dataset.modelProviderId).toBe(EXPECTED_PROVIDER_ID)
    expect(control.menu.isConnected).toBe(false)
  })
})
