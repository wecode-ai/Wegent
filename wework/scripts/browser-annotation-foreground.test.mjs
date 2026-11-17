import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import { createDesktopScenario } from '../e2e/desktop/scenarios/embedded-browser-annotation.scenario.mjs'

test('retained browser annotation core does not activate a retired foreground checkpoint', async () => {
  const argv = process.argv
  try {
    const catalog = loadDesktopCheckpointCatalog()
    assert.deepEqual(catalog.DESKTOP_CHECKPOINT_GROUPS.get('browser-annotation'), [
      'browser-annotation-core',
    ])
    assert.equal(
      catalog.CHECKPOINT_SCENARIO_MODULES['browser-annotation-core'],
      './scenarios/embedded-browser-annotation.scenario.mjs'
    )
    assert.equal(catalog.DESKTOP_CHECKPOINTS.includes('browser-annotation-design'), false)
    assert.equal(
      Object.hasOwn(catalog.CHECKPOINT_SCENARIO_MODULES, 'browser-annotation-design'),
      false
    )

    process.argv = [...argv, '--segment', 'browser-annotation-core']
    const scenario = createDesktopScenario({})
    const environment = { WEWORK_E2E_BACKGROUND_WINDOW: '1', ...scenario.appEnvironment }
    assert.equal(environment.WEWORK_E2E_BACKGROUND_WINDOW, '1')
    assert.deepEqual(scenario.appEnvironment, {})

    process.argv = [...argv, '--segment', 'browser-annotation-design']
    await assert.rejects(
      createDesktopScenario({}).verify({}),
      /Unsupported browser annotation checkpoint: browser-annotation-design/
    )
  } finally {
    process.argv = argv
  }
})
