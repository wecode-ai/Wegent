import assert from 'node:assert/strict'
import test from 'node:test'
import { CHECKPOINT_SCENARIO_MODULES, DESKTOP_CHECKPOINT_CI_HOSTS } from './checkpoints.mjs'
import { loadDesktopCheckpointCatalog } from './checkpoint-catalog.mjs'

test('project sidebar chat runs with the existing project settings CI lifecycle', () => {
  assert.equal(DESKTOP_CHECKPOINT_CI_HOSTS.get('project-sidebar-chat'), 'project-ai-settings')
  assert.equal(
    CHECKPOINT_SCENARIO_MODULES['project-sidebar-chat'],
    './scenarios/project-sidebar-chat.scenario.mjs'
  )
  const catalog = loadDesktopCheckpointCatalog()
  assert.deepEqual(
    catalog.PATH_TARGETS.get('wework/e2e/desktop/scenarios/project-sidebar-chat.scenario.mjs'),
    ['core:project-ai-settings']
  )
})
