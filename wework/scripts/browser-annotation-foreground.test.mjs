import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import { createDesktopScenario } from '../e2e/desktop/scenarios/embedded-browser-annotation.scenario.mjs'

test('native Original View key-down/key-up owns the foreground without background activation policy', () => {
  const argv = process.argv
  try {
    process.argv = [...argv, '--segment', 'browser-annotation-design']
    const scenario = createDesktopScenario({})
    const environment = { WEWORK_E2E_BACKGROUND_WINDOW: '1', ...scenario.appEnvironment }
    assert.equal(environment.WEWORK_E2E_BACKGROUND_WINDOW, '0')
    assert.deepEqual(
      loadDesktopCheckpointCatalog().CHECKPOINT_RESOURCES.get('browser-annotation-design'),
      ['macos-inspector-foreground']
    )
    process.argv = [...argv, '--segment', 'browser-annotation-core']
    assert.deepEqual(createDesktopScenario({}).appEnvironment, {})
  } finally {
    process.argv = argv
  }
})
