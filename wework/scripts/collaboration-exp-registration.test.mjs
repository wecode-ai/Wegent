import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import {
  createDesktopScenario,
  COLLABORATION_EXP_USER_STORIES,
} from '../e2e/desktop/scenarios/collaboration-exp.scenario.mjs'

test('collaboration experiment acceptance uses the existing core runner and owns its prerequisites', () => {
  const catalog = loadDesktopCheckpointCatalog()
  assert.equal(typeof createDesktopScenario, 'function')
  assert.deepEqual(
    catalog.PATH_TARGETS.get('wework/e2e/desktop/scenarios/collaboration-exp.scenario.mjs'),
    ['core:collaboration-exp']
  )
  assert.ok(catalog.ci.core_shards.some(shard => shard.split(',').includes('collaboration-exp')))
  assert.equal(createDesktopScenario({}).requiresCloudEnvironment, true)
  assert.equal(createDesktopScenario({}).requiresRemoteExecutor, false)
  assert.deepEqual(COLLABORATION_EXP_USER_STORIES, [
    'default-off-preserves-baseline-and-makes-no-targeted-business-requests',
    'deliberate-beta-toggle-and-fixed-tab-survive-reload',
    'local-and-cloud-issues-keep-their-canonical-source',
    'project-notifications-and-deep-links-reuse-one-experiment-tab',
    'assistant-tasks-project-timeline-private-discussion-work-in-three-viewports',
    'ordinary-assistant-question-creates-no-project-issue',
    'source-discussion-shows-only-the-proven-owned-native-turn',
    'edited-conclusion-publishes-exactly-once-and-rechecks-current-permission',
    'private-unsent-draft-and-query-survive-reload-and-native-restart',
    'disable-and-reenable-retain-experiment-data-and-old-collaboration',
  ])
})
