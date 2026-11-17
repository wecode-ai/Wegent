import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import { createDesktopScenario } from '../e2e/desktop/scenarios/embedded-browser-annotation.scenario.mjs'

test('retained browser annotation preserves the runner background policy', () => {
  const argv = process.argv
  try {
    process.argv = [...argv, '--segment', 'browser-annotation-core']
    const scenario = createDesktopScenario({})
    const environment = { WEWORK_E2E_BACKGROUND_WINDOW: '1', ...scenario.appEnvironment }
    assert.equal(environment.WEWORK_E2E_BACKGROUND_WINDOW, '1')
    const catalog = loadDesktopCheckpointCatalog()
    assert.ok(catalog.DESKTOP_CHECKPOINTS.includes('browser-annotation-core'))
    assert.deepEqual(catalog.DESKTOP_CHECKPOINT_GROUPS.get('browser-annotation'), [
      'browser-annotation-core',
    ])
  } finally {
    process.argv = argv
  }
})

test('pruned browser annotation design cannot acquire foreground ownership or run', async () => {
  const argv = process.argv
  try {
    process.argv = [...argv, '--segment', 'browser-annotation-design']
    const scenario = createDesktopScenario({})
    const catalog = loadDesktopCheckpointCatalog()
    assert.equal(catalog.DESKTOP_CHECKPOINTS.includes('browser-annotation-design'), false)
    assert.equal(catalog.CHECKPOINT_RESOURCES.has('browser-annotation-design'), false)
    assert.equal(catalog.CHECKPOINT_SCENARIO_MODULES['browser-annotation-design'], undefined)
    assert.equal(scenario.appEnvironment?.WEWORK_E2E_BACKGROUND_WINDOW, undefined)
    await assert.rejects(scenario.verify({}), {
      message: 'Unsupported browser annotation checkpoint: browser-annotation-design',
    })
  } finally {
    process.argv = argv
  }
})
