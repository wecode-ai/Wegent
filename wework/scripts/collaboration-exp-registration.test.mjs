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
  COLLABORATION_EXP_RHYTHM_MARKER,
  createCollaborationExpRhythmFixture,
} from '../e2e/desktop/modules/collaboration-exp-rhythm.mjs'
import { requestExecutor } from '../e2e/desktop/modules/executor-rpc.mjs'
import { readTeam } from '../e2e/desktop/modules/collaboration-exp-state-motion.mjs'

function rhythmProtocol() {
  const calls = []
  const issue = { id: 'LOCAL-1', status: 'in_progress', version: 2, created_by_user_id: 0 }
  const binding = { loop_item_id: issue.id, device_id: 'local-device', task_id: 'native-task' }
  const settings = {
    userId: 7,
    executionDeviceId: 'local-device',
    version: 1,
    roles: [
      {
        id: 'existing-role',
        name: 'Existing assistant',
        prompt: 'Preserve this role',
        executionDeviceId: 'local-device',
        enabled: false,
      },
    ],
  }
  let configured = structuredClone(settings)
  const state = { ownerId: 7, catalogs: [[{ runtime: 'codex', is_default: true }]] }
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
    'runtime.stand_in.binding': () => ({ target: { userId: state.ownerId } }),
    'runtime.stand_in.personal.get': () => structuredClone(configured),
    'runtime.stand_in.personal.save': input => {
      configured = { ...input.settings, version: configured.version + 1 }
      return structuredClone(configured)
    },
    'runtime.stand_in.device_identity': () => ({
      deviceId: 'local-device',
      backendDeviceId: 'registered-device',
    }),
    'runtime.runner.catalog': () => ({
      models: state.catalogs.length > 1 ? state.catalogs.shift() : state.catalogs[0],
    }),
    'runtime.stand_in.get': input => {
      assert.equal(input.projectId, 'local-project')
      assert.equal(input.projectStore, 'local')
      return structuredClone(
        configured.roles.find(role => role.id === COLLABORATION_EXP_RHYTHM_ROLE) ?? {
          id: COLLABORATION_EXP_RHYTHM_ROLE,
          executionDeviceId: configured.executionDeviceId,
        }
      )
    },
    'runtime.stand_in.save': input => {
      assert.equal(input.projectId, 'local-project')
      assert.equal(input.projectStore, 'local')
      const role = structuredClone(input.settings)
      configured = {
        ...configured,
        version: configured.version + 1,
        roles: [...configured.roles.filter(existing => existing.id !== role.id), role],
      }
      return role
    },
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
  return {
    rpc,
    calls,
    issue,
    binding,
    settings,
    task,
    bindings,
    tasks,
    state,
    current: () => configured,
  }
}

test('collaboration experiment acceptance uses the existing core runner and owns its prerequisites', () => {
  const catalog = loadDesktopCheckpointCatalog()
  assert.equal(typeof createDesktopScenario, 'function')
  assert.deepEqual(
    catalog.PATH_TARGETS.get('wework/e2e/desktop/scenarios/collaboration-exp.scenario.mjs'),
    ['core:collaboration-exp']
  )
  assert.ok(catalog.ci.core_shards.some(shard => shard.split(',').includes('collaboration-exp')))
  for (const helper of [
    'collaboration-exp-rhythm',
    'collaboration-exp-account-setup',
    'collaboration-exp-state-motion',
    'collaboration-exp-pane-verification',
    'collaboration-exp-viewport-flows',
  ])
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
    'ordinary-private-message-preserves-canonical-issue-status-and-shared-comments',
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

test('team evidence requires the same visible status, accessible name and state indicator', async () => {
  const node = {
    width: 100,
    height: 80,
    text: 'Integration assistant 推进中',
    attributes: {
      'data-assistant-id': 'integration',
      'data-state': 'running',
      'aria-label': 'Integration assistant · 推进中 · 配置',
    },
  }
  const indicator = { width: 6, height: 6, attributes: { 'data-state': 'running' } }
  let indicators = [indicator]
  const control = {
    command: async (action, selector) => {
      assert.equal(action, 'getElementMetrics')
      return JSON.stringify(selector.includes('.assistant-presence-mark') ? indicators : [node])
    },
  }
  assert.equal((await readTeam(control, 'team'))[0].state, 'running')
  node.attributes['aria-label'] = 'Integration assistant'
  await assert.rejects(() => readTeam(control, 'team'), /accessible name/)
  node.attributes['aria-label'] = 'Integration assistant · 推进中 · 配置'
  indicators = []
  await assert.rejects(() => readTeam(control, 'team'), /semantic indicator/)
  indicators = [indicator]
  indicator.attributes['data-state'] = 'idle'
  await assert.rejects(() => readTeam(control, 'team'), /idle.*running/s)
  indicator.attributes['data-state'] = 'running'
  indicator.width = 0
  await assert.rejects(() => readTeam(control, 'team'), /visible state indicator/)
})

test('rhythm waits for the bound native task without requiring a robot execution projection', async () => {
  const protocol = rhythmProtocol()
  const fixture = createCollaborationExpRhythmFixture(protocol.rpc, 1000)
  const result = await fixture.prepare({ id: 'local-project' }, { id: 'LOCAL-2' }, 7)
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
  const version = protocol.current().version
  await fixture.cleanup()
  assert.equal(protocol.calls.at(-1).method, 'runtime.stand_in.personal.save')
  assert.deepEqual(protocol.calls.at(-1).input, {
    userId: 7,
    settings: { ...protocol.settings, version },
  })
  assert.deepEqual(protocol.current().roles, protocol.settings.roles)
})

test('rhythm rejects an in-progress Issue when its bound native task is not running', async () => {
  const protocol = rhythmProtocol()
  protocol.bindings.splice(0, 1)
  protocol.tasks.splice(1, 1)
  const fixture = createCollaborationExpRhythmFixture(protocol.rpc, 20)
  await assert.rejects(
    () => fixture.prepare({ id: 'local-project' }, { id: 'LOCAL-2' }, 7),
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
      7
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
      7
    )
  )
  assert.equal(
    otherIssue.calls.some(call => call.method === 'todos.get'),
    false
  )
})

test('early native role preparation creates no Issue or execution and late dispatch preserves its owner/device and original team', async () => {
  const protocol = rhythmProtocol()
  const fixture = createCollaborationExpRhythmFixture(protocol.rpc, 1000)
  const prepared = await fixture.prepareRole({ id: 'local-project' }, 7)
  assert.equal(prepared.userId, 7)
  assert.equal(prepared.executionDeviceId, 'local-device')
  const role = prepared.roles.find(role => role.id === COLLABORATION_EXP_RHYTHM_ROLE)
  assert.equal(role.name, 'Integration assistant')
  assert.equal(role.prompt, COLLABORATION_EXP_RHYTHM_MARKER)
  assert.equal(role.executionDeviceId, prepared.executionDeviceId)
  assert.equal(
    protocol.calls.some(
      call => call.method.startsWith('todos.') || call.method === 'runtime.stand_in.run'
    ),
    false
  )
  const execution = await fixture.prepare({ id: 'local-project' }, { id: 'LOCAL-2' }, 7)
  assert.equal(execution.ownerId, prepared.userId)
  assert.equal(execution.address.deviceId, prepared.executionDeviceId)
  await fixture.cleanup()
  assert.deepEqual(protocol.current().roles, protocol.settings.roles)
})

for (const fault of ['owner', 'device'])
  test('late dispatch rejects a changed prepared ' + fault, async () => {
    const protocol = rhythmProtocol()
    const fixture = createCollaborationExpRhythmFixture(protocol.rpc, 1000)
    await fixture.prepareRole({ id: 'local-project' }, 7)
    if (fault === 'owner') protocol.state.ownerId = 8
    else protocol.current().executionDeviceId = 'another-device'
    await assert.rejects(
      () => fixture.prepare({ id: 'local-project' }, { id: 'LOCAL-2' }, 7),
      /must remain unchanged/
    )
    assert.equal(
      protocol.calls.some(
        call => call.method === 'todos.create' || call.method === 'runtime.stand_in.run'
      ),
      false
    )
  })

test('early preparation waits for the actual default model within its startup deadline', async () => {
  const protocol = rhythmProtocol()
  protocol.state.catalogs.unshift([])
  const fixture = createCollaborationExpRhythmFixture(protocol.rpc, 1000)
  await fixture.prepareRole({ id: 'local-project' }, 7, 1000)
  assert.equal(protocol.calls.filter(call => call.method === 'runtime.runner.catalog').length, 2)
  const role = protocol.current().roles.find(role => role.id === COLLABORATION_EXP_RHYTHM_ROLE)
  assert.equal(role.model.is_default, true)
  assert.equal(role.executionDeviceId, 'local-device')
})

test('missing default model fails at the startup deadline before saving a role or creating work', async () => {
  const protocol = rhythmProtocol()
  protocol.state.catalogs = [[]]
  const fixture = createCollaborationExpRhythmFixture(protocol.rpc, 1000)
  await assert.rejects(
    () => fixture.prepareRole({ id: 'local-project' }, 7, 20),
    /configured E2E model/
  )
  assert.equal(
    protocol.calls.some(
      call =>
        call.method === 'runtime.stand_in.save' ||
        call.method.startsWith('todos.') ||
        call.method === 'runtime.stand_in.run'
    ),
    false
  )
})

const pendingRegistration = {
  status: 500,
  error: {
    code: 'cloud_unavailable',
    message: 'Wait for this Runtime to register with the backend',
  },
}

// Exercise the scenario's actual raw native response adapter, including typed failures.
function registrationRpc(protocol, identityReplies) {
  const calls = []
  const control = {
    async command(action, selector, options) {
      if (action === 'getLocationOrigin') return 'http://127.0.0.1:4100'
      assert.equal(action, 'fetchLocalRuntime')
      const init = JSON.parse(options.value)
      const { method, params } = JSON.parse(init.body)
      calls.push({ method, timeoutMs: init.timeoutMs })
      const reply =
        method === 'runtime.stand_in.device_identity' && identityReplies.length
          ? identityReplies.shift()
          : null
      const payload = reply?.error
        ? { ok: false, error: reply.error }
        : { ok: true, result: reply?.result ?? (await protocol.rpc(method, params)) }
      return JSON.stringify({
        status: reply?.status ?? 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    },
  }
  return {
    calls,
    rpc: (method, params, timeoutMs = 1000) => requestExecutor(control, method, params, timeoutMs),
  }
}

test('early preparation waits for genuine registered identity before reading the native owner/profile', async () => {
  const protocol = rhythmProtocol()
  const native = registrationRpc(protocol, [pendingRegistration])
  const prepared = await createCollaborationExpRhythmFixture(native.rpc, 1000).prepareRole(
    { id: 'local-project' },
    7,
    1000
  )
  assert.equal(
    native.calls.filter(call => call.method === 'runtime.stand_in.device_identity').length,
    2
  )
  const identity = native.calls.findLastIndex(
    call => call.method === 'runtime.stand_in.device_identity'
  )
  assert.ok(native.calls.findIndex(call => call.method === 'runtime.stand_in.binding') > identity)
  assert.ok(
    native.calls.findIndex(call => call.method === 'runtime.stand_in.personal.get') > identity
  )
  assert.equal(prepared.userId, 7)
  assert.equal(prepared.executionDeviceId, 'local-device')
  const role = prepared.roles.find(role => role.id === COLLABORATION_EXP_RHYTHM_ROLE)
  assert.equal(role.executionDeviceId, prepared.executionDeviceId)
  assert.equal(role.model.is_default, true)
  assert.equal(
    protocol.calls.some(call => call.method.startsWith('todos.')),
    false
  )
})

for (const [name, reply] of [
  [
    'another native error code',
    { ...pendingRegistration, error: { ...pendingRegistration.error, code: 'query_failed' } },
  ],
  [
    'another cloud_unavailable error',
    {
      ...pendingRegistration,
      error: { ...pendingRegistration.error, message: 'Cloud authorization is required' },
    },
  ],
  ['another HTTP status', { ...pendingRegistration, status: 503 }],
])
  test('early registration readiness rejects ' + name + ' immediately', async () => {
    const protocol = rhythmProtocol()
    const native = registrationRpc(protocol, [reply])
    await assert.rejects(() =>
      createCollaborationExpRhythmFixture(native.rpc, 1000).prepareRole(
        { id: 'local-project' },
        7,
        1000
      )
    )
    assert.equal(
      native.calls.filter(call => call.method === 'runtime.stand_in.device_identity').length,
      1
    )
    assert.equal(
      protocol.calls.some(
        call =>
          call.method === 'runtime.stand_in.personal.get' || call.method === 'runtime.stand_in.save'
      ),
      false
    )
  })

test('registration and default-model discovery share the original startup deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const protocol = rhythmProtocol()
  const native = registrationRpc(protocol, [pendingRegistration])
  const observed = []
  let catalogReads = 0
  const rpc = async (method, params, timeoutMs) => {
    observed.push({ method, timeoutMs })
    const result = await native.rpc(method, params, timeoutMs)
    if (method === 'runtime.runner.catalog') {
      catalogReads++
      t.mock.timers.tick(catalogReads === 1 ? 160 : 80)
      return { models: catalogReads === 1 ? [] : result.models }
    }
    return result
  }
  const fixture = createCollaborationExpRhythmFixture(rpc, 1000)
  const failure = assert.rejects(
    fixture.prepareRole({ id: 'local-project' }, 7, 300),
    /register.*configured E2E model/
  )
  for (let turn = 0; turn < 30; turn++) await Promise.resolve()
  t.mock.timers.tick(100)
  await failure
  assert.equal(catalogReads, 2)
  assert.deepEqual(
    observed
      .filter(call => call.method === 'runtime.stand_in.device_identity')
      .map(call => call.timeoutMs),
    [300, 40]
  )
  assert.equal(
    observed.some(
      call =>
        call.method === 'runtime.stand_in.personal.get' || call.method === 'runtime.stand_in.save'
    ),
    false
  )
})

for (const fault of ['owner', 'profile owner', 'local device', 'backend device'])
  test('registered readiness rejects a mismatched ' + fault + ' before saving a role', async () => {
    const protocol = rhythmProtocol()
    if (fault === 'owner') protocol.state.ownerId = 8
    if (fault === 'profile owner') protocol.current().userId = 8
    const identity = {
      deviceId: fault === 'local device' ? 'another-device' : 'local-device',
      backendDeviceId: fault === 'backend device' ? '' : 'registered-device',
    }
    const native = registrationRpc(protocol, [{ result: identity }])
    await assert.rejects(() =>
      createCollaborationExpRhythmFixture(native.rpc, 1000).prepareRole(
        { id: 'local-project' },
        7,
        1000
      )
    )
    assert.equal(
      protocol.calls.some(call => call.method === 'runtime.stand_in.save'),
      false
    )
  })

for (const failure of ['catalog', 'transport'])
  test('registration readiness never retries an unrelated ' + failure + ' failure', async () => {
    const protocol = rhythmProtocol()
    const native = registrationRpc(protocol, failure === 'catalog' ? [pendingRegistration] : [])
    const expected = new Error('unrelated ' + failure + ' failure')
    const rpc = (method, params, timeoutMs) =>
      method ===
      (failure === 'catalog' ? 'runtime.runner.catalog' : 'runtime.stand_in.device_identity')
        ? Promise.reject(expected)
        : native.rpc(method, params, timeoutMs)
    await assert.rejects(
      () =>
        createCollaborationExpRhythmFixture(rpc, 1000).prepareRole(
          { id: 'local-project' },
          7,
          1000
        ),
      error => error === expected
    )
    assert.equal(
      protocol.calls.some(
        call =>
          call.method === 'runtime.stand_in.personal.get' || call.method === 'runtime.stand_in.save'
      ),
      false
    )
  })
