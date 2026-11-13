import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import {
  createDesktopScenario,
  COLLABORATION_EXP_USER_STORIES,
} from '../e2e/desktop/scenarios/collaboration-exp.scenario.mjs'
import {
  assertNoStateAnimation,
  assertUnchangedGeometry,
} from '../e2e/desktop/modules/collaboration-exp-rhythm.mjs'
import { readTeam } from '../e2e/desktop/modules/collaboration-exp-state-motion.mjs'

test('collaboration experiment acceptance uses the existing core runner and owns its prerequisites', () => {
  const catalog = loadDesktopCheckpointCatalog()
  assert.equal(typeof createDesktopScenario, 'function')
  assert.deepEqual(
    catalog.PATH_TARGETS.get('wework/e2e/desktop/scenarios/collaboration-exp.scenario.mjs'),
    ['core:collaboration-exp']
  )
  assert.ok(catalog.ci.core_shards.some(shard => shard.split(',').includes('collaboration-exp')))
  for (const helper of ['collaboration-exp-rhythm', 'collaboration-exp-state-motion'])
    assert.deepEqual(catalog.PATH_TARGETS.get(`wework/e2e/desktop/modules/${helper}.mjs`), [
      'core:collaboration-exp',
    ])
  assert.equal(createDesktopScenario({}).requiresCloudEnvironment, true)
  assert.equal(createDesktopScenario({}).requiresRemoteExecutor, false)
  assert.deepEqual(COLLABORATION_EXP_USER_STORIES, [
    'default-off-preserves-baseline-and-makes-no-targeted-business-requests',
    'deliberate-beta-toggle-and-fixed-tab-survive-reload',
    'local-and-cloud-issues-keep-their-canonical-source',
    'project-notifications-and-deep-links-reuse-one-experiment-tab',
    'assistant-tasks-project-timeline-private-discussion-work-in-three-viewports',
    'reduced-motion-keeps-real-team-and-task-rhythm-states-readable-without-layout-shifts',
    'ordinary-assistant-question-creates-no-project-issue',
    'source-discussion-shows-only-the-proven-owned-native-turn',
    'edited-conclusion-publishes-exactly-once-and-rechecks-current-permission',
    'private-unsent-draft-and-query-survive-reload-and-native-restart',
    'disable-and-reenable-retain-experiment-data-and-old-collaboration',
  ])
})

test('motion evidence rejects a remaining pulse, trail or nonzero animation duration', () => {
  assertNoStateAnimation('none', '0s', 'disabled')
  assertNoStateAnimation('none, none', '0s, 0s', 'disabled list')
  assert.throws(() => assertNoStateAnimation('experience-work-pulse', '0s', 'pulse'))
  assert.throws(() => assertNoStateAnimation('none, experience-work-trail', '0s, 2s', 'trail'))
  assert.throws(() => assertNoStateAnimation('none', '0.15s', 'entry'))
})

test('frame evidence rejects detached geometry, count changes and actual layout shifts', () => {
  const before = [{ left: 4, top: 10, width: 300, height: 88 }]
  assertUnchangedGeometry(before, [{ ...before[0], top: 10.5 }], 'subpixel')
  assert.throws(() => assertUnchangedGeometry(before, [], 'missing'))
  assert.throws(() => assertUnchangedGeometry(before, [{ ...before[0], top: 12 }], 'shift'))
  assert.throws(() => assertUnchangedGeometry(before, [{ ...before[0], width: 280 }], 'resize'))
})

test('team evidence requires the same visible status, accessible name and icon', async () => {
  const node = {
    text: 'Integration assistant 推进中',
    attributes: {
      'data-assistant-id': 'integration',
      'data-state': 'running',
      'aria-label': 'Integration assistant · 推进中 · 配置',
    },
  }
  let icons = 1
  const control = {
    command: async action =>
      action === 'getElementMetrics' ? JSON.stringify([node]) : String(icons),
  }
  assert.equal((await readTeam(control, 'team'))[0].state, 'running')
  node.attributes['aria-label'] = 'Integration assistant'
  await assert.rejects(() => readTeam(control, 'team'), /accessible name/)
  node.attributes['aria-label'] = 'Integration assistant · 推进中 · 配置'
  icons = 0
  await assert.rejects(() => readTeam(control, 'team'), /semantic icon/)
})
