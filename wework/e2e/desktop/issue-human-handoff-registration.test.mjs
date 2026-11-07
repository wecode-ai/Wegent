import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from './checkpoint-catalog.mjs'
import {
  createDesktopScenario,
  HUMAN_HANDOFF_USER_STORIES,
} from './scenarios/issue-human-handoff.scenario.mjs'

test('the native Issue handoff scenario is discoverable and runs in core CI', () => {
  const catalog = loadDesktopCheckpointCatalog()
  assert.deepEqual(
    catalog.PATH_TARGETS.get('wework/e2e/desktop/scenarios/issue-human-handoff.scenario.mjs'),
    ['core:issue-human-handoff']
  )
  assert.equal(typeof createDesktopScenario, 'function')
  assert.deepEqual(HUMAN_HANDOFF_USER_STORIES, [
    'creator-owns-idle-issue-without-invented-ai-progress',
    'project-quick-filter-matches-the-current-human',
    'project-work-appears-in-the-global-pending-tab',
    'native-question-is-persistent-and-targeted',
    'transfer-has-an-exact-handoff-time-and-audit-trail',
    'queued-answer-does-not-complete-the-handoff',
    'accepted-answer-resumes-the-original-thread-exactly-once',
  ])
})
