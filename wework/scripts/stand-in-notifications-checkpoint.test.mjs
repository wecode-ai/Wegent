import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-notifications.scenario.mjs'

test('stand-in IM native keyboard runs in the foreground without competing for native focus', () => {
  const scenario = createDesktopScenario({})
  const environment = { WEWORK_E2E_BACKGROUND_WINDOW: '1', ...scenario.appEnvironment }
  assert.equal(environment.WEWORK_E2E_BACKGROUND_WINDOW, '0')
  assert.deepEqual(
    loadDesktopCheckpointCatalog().CHECKPOINT_RESOURCES.get('stand-in-notifications'),
    ['macos-inspector-foreground']
  )
})
