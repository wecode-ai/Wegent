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
  COLLABORATION_EXP_RHYTHM_ROLE,
  createCollaborationExpRhythmFixture,
} from '../e2e/desktop/modules/collaboration-exp-rhythm.mjs'
import { readTeam } from '../e2e/desktop/modules/collaboration-exp-state-motion.mjs'

function rhythmProtocol() {
  const calls = []
  const issue = { id: 'LOCAL-1', status: 'in_progress', version: 2, created_by_user_id: 0 }
  const binding = { loop_item_id: issue.id, device_id: 'local-device', task_id: 'native-task' }
  const settings = { version: 1, roles: [{ id: COLLABORATION_EXP_RHYTHM_ROLE, enabled: true }] }
  const task = {
    taskId: binding.task_id,
    status: 'running',
    running: true,
    runtimeHandle: {
      origin: {
        type: 'issue_dispatch',
        initiatedBy: 'stand_in',
        standInId: COLLABORATION_EXP_RHYTHM_ROLE,
        userId: 7,
        projectStore: 'local',
        cloudProjectId: 'local-project',
        loopItemId: issue.id,
      },
    },
  }
  const bindings = [[], [binding]]
  const tasks = [{ ...task, status: 'queued', running: false }, task]
  const handlers = {
    'runtime.stand_in.binding': () => ({ target: { userId: 7 } }),
    'runtime.stand_in.personal.get': () => settings,
    'runtime.stand_in.personal.save': input => input.settings,
    'runtime.runner.catalog': () => ({ models: [{ runtime: 'codex', is_default: true }] }),
    'runtime.stand_in.get': () => ({ id: COLLABORATION_EXP_RHYTHM_ROLE }),
    'runtime.stand_in.save': input => input.settings,
    'runtime.stand_in.run': () => ({ success: true }),
    'todos.create': () => ({ ...issue, status: 'inbox' }),
    'todos.bindings': () => (bindings.length > 1 ? bindings.shift() : bindings[0]),
    'runtime.tasks.get': () => ({
      success: true,
      task: tasks.length > 1 ? tasks.shift() : tasks[0],
    }),
    'todos.get': input => (input.task_id === issue.id ? issue : { id: 'LOCAL-2', version: 1 }),
    'todos.update': input => ({ id: input.task_id, ...input.todo }),
  }
  const rpc = async (method, input) => {
    calls.push({ method, input })
    assert.ok(handlers[method], `Unexpected fixture RPC: ${method}`)
    return handlers[method](input)
  }
  return { rpc, calls, issue, binding, settings, task, bindings, tasks }
}

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
    'demo-create-cancels-without-writes-and-persists-native-standalone-and-cloud-project-issues',
    'native-issue-details-edit-the-same-canonical-issue-and-refresh-the-timeline',
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

test('rhythm waits for the bound native task without requiring a robot execution projection', async () => {
  const protocol = rhythmProtocol()
  const fixture = createCollaborationExpRhythmFixture(protocol.rpc, 1000)
  const result = await fixture.prepare({ id: 'local-project' }, { id: 'LOCAL-2' }, 99)
  assert.equal(result.runningIssue, protocol.issue)
  assert.equal(result.runningIssue.execution_state, undefined)
  assert.equal(result.runningIssue.created_by_user_id, 0)
  assert.equal(result.ownerId, 7)
  assert.deepEqual(result.address, { deviceId: 'local-device', taskId: 'native-task' })
  assert.equal(protocol.calls.filter(call => call.method === 'runtime.stand_in.run').length, 1)
  assert.equal(protocol.calls.filter(call => call.method === 'todos.bindings').length, 2)
  assert.equal(protocol.calls.filter(call => call.method === 'runtime.tasks.get').length, 2)
  const methods = protocol.calls.map(call => call.method)
  assert.ok(methods.indexOf('todos.bindings') < methods.indexOf('runtime.tasks.get'))
  assert.ok(methods.indexOf('runtime.tasks.get') < methods.indexOf('todos.get'))
  await fixture.cleanup()
  assert.equal(protocol.calls.at(-1).method, 'runtime.stand_in.personal.save')
  assert.deepEqual(protocol.calls.at(-1).input, { userId: 7, settings: protocol.settings })
})

test('rhythm rejects an in-progress Issue when its bound native task is not running', async () => {
  const protocol = rhythmProtocol()
  protocol.bindings.splice(0, 1)
  protocol.tasks.splice(1, 1)
  const fixture = createCollaborationExpRhythmFixture(protocol.rpc, 20)
  await assert.rejects(
    () => fixture.prepare({ id: 'local-project' }, { id: 'LOCAL-2' }, 99),
    /owning executor did not expose running task native-task/
  )
  assert.equal(
    protocol.calls.some(call => call.method === 'todos.get'),
    false
  )
})

test('rhythm requires one binding and the exact local Issue origin', async () => {
  const duplicated = rhythmProtocol()
  duplicated.bindings.splice(0, 2, [duplicated.binding, duplicated.binding])
  await assert.rejects(() =>
    createCollaborationExpRhythmFixture(duplicated.rpc, 1000).prepare(
      { id: 'local-project' },
      { id: 'LOCAL-2' },
      99
    )
  )
  assert.equal(
    duplicated.calls.some(call => call.method === 'runtime.tasks.get'),
    false
  )

  const otherIssue = rhythmProtocol()
  otherIssue.bindings.splice(0, 1)
  otherIssue.tasks.splice(0, 1)
  otherIssue.task.runtimeHandle.origin.loopItemId = 'OTHER-1'
  await assert.rejects(() =>
    createCollaborationExpRhythmFixture(otherIssue.rpc, 1000).prepare(
      { id: 'local-project' },
      { id: 'LOCAL-2' },
      99
    )
  )
  assert.equal(
    otherIssue.calls.some(call => call.method === 'todos.get'),
    false
  )
})
