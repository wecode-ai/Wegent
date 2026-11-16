import assert from 'node:assert/strict'
import test from 'node:test'
import { CHECKPOINT_SCENARIO_MODULES, DESKTOP_CHECKPOINT_CI_HOSTS } from './checkpoints.mjs'
import { loadDesktopCheckpointCatalog } from './checkpoint-catalog.mjs'

test('project Issue queries reuse the existing project settings CI lifecycle', () => {
  assert.equal(
    DESKTOP_CHECKPOINT_CI_HOSTS.get('project-sidebar-issue-query'),
    'project-ai-settings'
  )
  assert.equal(
    CHECKPOINT_SCENARIO_MODULES['project-sidebar-issue-query'],
    './scenarios/project-sidebar-issue-query.scenario.mjs'
  )
  assert.deepEqual(
    loadDesktopCheckpointCatalog().PATH_TARGETS.get(
      'wework/e2e/desktop/scenarios/project-sidebar-issue-query.scenario.mjs'
    ),
    ['core:project-ai-settings']
  )
})
