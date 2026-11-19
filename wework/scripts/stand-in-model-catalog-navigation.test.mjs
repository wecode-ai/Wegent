// @vitest-environment node

import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-model-catalog.scenario.mjs'

const fixtures = vi.hoisted(() => ({ rpc: vi.fn(), open: vi.fn() }))
vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor: fixtures.rpc }))
vi.mock('../e2e/desktop/modules/stand-in-profile-navigation.mjs', () => ({
  openStandInSettings: fixtures.open,
}))
vi.mock('../e2e/desktop/modules/stand-in-instance-flows.mjs', () => ({
  bindStoppedStandIn: vi.fn(),
  finishStandInOnboarding: vi.fn(),
  stopBoundStandIn: vi.fn(),
}))
vi.mock('../e2e/desktop/modules/preferences-automation-flows.mjs', () => ({
  ensureExperimentalFeaturesEnabled: vi.fn(),
}))
vi.mock('../e2e/desktop/modules/shared.mjs', () => ({
  ACTIVE_WORKBENCH_SELECTOR: '[data-testid="desktop-workbench-main"]',
  CLOUD_PUBLIC_MODEL_NAME: 'fixture-public',
  ensureModelOptionVisible: vi.fn(),
  fetchJson: vi.fn(),
}))

afterEach(() => vi.clearAllMocks())

test('reveals the model list after reopening a saved fixed model with reasoning controls', async () => {
  let panelOpen = false
  let menuOpen = false
  let view = 'advanced'
  let selected
  let saved = { version: 1, executionDeviceId: 'local-test-device', primary: { model: {} } }
  const selections = []
  const viewsOpened = []
  fixtures.open.mockImplementation(async () => {
    panelOpen = true
  })
  fixtures.rpc.mockImplementation(async (_control, method) => {
    assert.ok(['runtime.stand_in.personal.get', 'runtime.stand_in.personal.save'].includes(method))
    return saved
  })
  const control = {
    async command(action, selector, options = {}) {
      if (action === 'clickWhenEnabled' && selector.includes('model-selector-button')) {
        assert.equal(panelOpen, true)
        menuOpen = true
        view = selected ? 'simple' : 'advanced'
        viewsOpened.push(view)
        return ''
      }
      if (action === 'clickWhenEnabled' && selector.includes('model-advanced-toggle')) {
        assert.equal(menuOpen, true)
        assert.equal(view, 'simple')
        view = 'advanced'
        return ''
      }
      if (action === 'getAttribute' && options.value === 'data-panel') return view
      if (action === 'getElementCount' && selector.includes('model-selector-menu')) {
        assert.equal(menuOpen, true)
        assert.equal(options.visible, true)
        return view === 'advanced' ? '1' : '0'
      }
      if (action === 'clickWhenEnabled' && selector.startsWith('[data-testid="model-option-[')) {
        assert.equal(menuOpen, true)
        assert.equal(view, 'advanced', 'The mounted model list is inert in the reasoning view')
        const id = JSON.parse(selector.slice('[data-testid='.length, -1))
        const key = JSON.parse(id.slice('model-option-'.length))
        selected = key.at(-1)
        selections.push(selected)
        view = 'simple'
        return ''
      }
      if (action === 'press' && options.key === 'Escape') {
        menuOpen = false
        return ''
      }
      if (action === 'clickWhenEnabled' && selector.includes('stand-in-primary-save')) {
        assert.equal(menuOpen, false, 'The picker must release the parent settings before saving')
        panelOpen = false
        saved = {
          ...saved,
          version: saved.version + 1,
          primary: {
            model: {
              runtime: 'codex',
              source: 'cloud',
              provider: 'cloud',
              model_id: 'kimi-k3',
              cloud_model: {
                name: selected,
                type: 'public',
                namespace: 'default',
                resource_user_id: 0,
              },
            },
          },
        }
        return ''
      }
      if (action === 'waitFor') {
        if (selector.includes('model-selector-menu')) {
          assert.equal(menuOpen, options.visible !== false)
          if (selector.includes('data-panel="advanced"')) assert.equal(view, 'advanced')
        }
        if (selector === '[data-testid="stand-in-primary-profile"]')
          assert.equal(panelOpen, options.visible !== false)
        return ''
      }
      if (['click', 'clickWhenEnabled', 'scrollIntoView'].includes(action)) return ''
      throw new Error(`Unexpected control command: ${action} ${selector}`)
    },
  }
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await createDesktopScenario({ uiTimeoutMs: 1000 }).verify(control)
  } finally {
    errorLog.mockRestore()
  }
  assert.deepEqual(viewsOpened, ['advanced', 'simple', 'simple'])
  assert.deepEqual(selections, [
    'catalog-kimi-intranet',
    'catalog-kimi-public',
    'catalog-kimi-unmarked',
  ])
})
