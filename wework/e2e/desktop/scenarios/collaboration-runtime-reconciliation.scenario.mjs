import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { join } from 'node:path'

import { holdDatabaseLock } from '../modules/database-lock.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { readProjectChatMessages } from '../modules/project-chat-snapshot.mjs'
import { RuntimeEventProxy } from '../modules/runtime-event-proxy.mjs'
import { createRuntimeReconciliationModel } from '../modules/runtime-reconciliation-model.mjs'
import { REMOTE_DOCKER_DEVICE_ID } from '../modules/shared.mjs'
import { stopProcessGroup } from '../process-lifecycle.mjs'
import { reloadMainWindow, selectCollaborationDomain } from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const MARKER = `RUNTIME_RECONCILIATION_${process.pid}`
const ORDERS = ['snapshot-first', 'event-first', 'terminal-interleaved']
const TERMINAL = new Set(['done', 'completed', 'succeeded'])

function jsonValue(value) {
  return typeof value === 'string' ? JSON.parse(value) : value
}

async function until(load, accept, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  do {
    latest = await load()
    const result = accept(latest)
    if (result) return result === true ? latest : result
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

async function connectSocket(backendUrl, authToken, timeoutMs) {
  const { io } = createRequire(
    new URL('../../../../packages/chat-core/package.json', import.meta.url)
  )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
  const socket = io(`${backendUrl}/wework-runtime`, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token: authToken },
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: timeoutMs,
  })
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('connect_error', reject)
      socket.connect()
    })
    return socket
  } catch (error) {
    socket.disconnect()
    throw error
  }
}

async function loadSnapshotProjector() {
  const source = new URL('../../../../packages/chat-core/src/', import.meta.url)
  // Node 24 strips TypeScript; only the package's extensionless imports need resolving.
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const packageImport = context.parentURL?.startsWith(source.href)
      const relativeImport = specifier.startsWith('./') || specifier.startsWith('../')
      return nextResolve(
        packageImport && relativeImport && !specifier.endsWith('.ts')
          ? `${specifier}.ts`
          : specifier,
        context
      )
    },
  })
  try {
    return (await import(new URL('runtime-execution-snapshot.ts', source))).runtimeExecutionSnapshot
  } finally {
    hook.deregister()
  }
}

// The API, database, gateway, device, native session and Electron renderer are real.
// The loopback model is the only mocked service; the proxy delays its actual events.
export async function createDesktopScenario({
  uiTimeoutMs,
  modelResponseTimeoutMs,
  workbenchReadyTimeoutMs,
  resultDir,
}) {
  const executionSnapshot = await loadSnapshotProjector()
  const model = createRuntimeReconciliationModel({ marker: MARKER, orders: ORDERS })
  const { cases } = model
  const heldTasks = new Set()
  const evidence = []
  let cloud
  let backendUrl
  let authToken
  let workspace
  let project
  let agent
  let remote
  let proxy
  let socket

  async function request(path, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(`${backendUrl}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
    const text = await response.text()
    const value = text ? JSON.parse(text) : null
    assert.equal(response.ok, true, `${method} ${path}: HTTP ${response.status} ${text}`)
    return value
  }

  async function emit(event, payload, timeoutMs = uiTimeoutMs) {
    const ack = await socket.timeout(timeoutMs).emitWithAck(event, payload)
    assert.equal(ack.ok, true, `${event}: ${JSON.stringify(ack.error)}`)
    return ack.result
  }

  const rpc = (method, params) =>
    emit('runtime:request', {
      type: 'request',
      id: `${MARKER}-${randomUUID()}`,
      method,
      params,
      device_id: REMOTE_DOCKER_DEVICE_ID,
      timeout_seconds: uiTimeoutMs / 1000,
    })

  async function rows(testCase) {
    const [executions, activities, issues] = await Promise.all([
      cloud.queryDatabase(
        'SELECT id, status, last_event_seq, completed_at, runtime_instance_id FROM loop_item_executions WHERE loop_item_id = %s ORDER BY id',
        [testCase.issue.id]
      ),
      cloud.queryDatabase(
        'SELECT message_id, content, status, metadata FROM project_chat_messages WHERE project_id = %s AND task_id = %s AND sender_type = %s ORDER BY id',
        [project.id, testCase.issue.id, 'agent']
      ),
      cloud.queryDatabase('SELECT status, version, metadata FROM loop_items WHERE id = %s', [
        testCase.issue.id,
      ]),
    ])
    return {
      executions,
      activities: activities.map(row => ({ ...row, metadata: jsonValue(row.metadata) })),
      issue: { ...issues[0], metadata: jsonValue(issues[0]?.metadata) },
    }
  }

  async function messages(testCase) {
    return readProjectChatMessages(
      { backendUrl, authToken, projectId: project.id },
      testCase.issue.id,
      uiTimeoutMs
    )
  }

  async function setupRemote() {
    remote = await cloud.waitForDeviceType(REMOTE_DOCKER_DEVICE_ID, 'remote')
    const originalInstance = remote.runtime_instance_id
    proxy = await new RuntimeEventProxy(cloud.socketUrl).start()
    proxy.hold = envelope => heldTasks.has(envelope.payload?.taskId)
    await stopProcessGroup(cloud.remoteDockerExecutor)
    await cloud.waitForDeviceStatus(
      REMOTE_DOCKER_DEVICE_ID,
      'offline',
      cloud.remoteDockerExecutorLogPath
    )
    cloud.remoteDockerExecutorEnv.WEGENT_SOCKET_URL = proxy.url
    cloud.remoteDockerExecutor = await cloud.spawnExecutor(
      cloud.remoteDockerExecutorEnv,
      cloud.remoteDockerExecutorLogPath
    )
    remote = await cloud.waitForDeviceStatus(
      REMOTE_DOCKER_DEVICE_ID,
      'online',
      cloud.remoteDockerExecutorLogPath
    )
    assert.equal(remote.runtime_instance_id, originalInstance)
    assert.ok(proxy.websockets.size, 'The real remote Executor must use the transport proxy')
  }

  async function setupAgent() {
    await request(`/v1/workspaces/${workspace.id}/execution-environments`, { device_id: remote.id })
    await request(`/v1/cloud-projects/${project.id}/execution-environments`, {
      device_id: remote.id,
    })
    const catalog = await rpc('runtime.runner.catalog', {})
    const model = catalog.models.find(
      candidate => candidate.runtime === 'codex' && candidate.is_default
    )
    assert.ok(model, 'The real remote Executor must advertise its native Codex model')
    agent = await request(`/v1/cloud-projects/${project.id}/chat-agents`, {
      name: `${MARKER}-agent`,
      runtime: 'codex',
      system_prompt: `${MARKER}: finish the assigned Issue directly without tools.`,
      execution_policy: { mode: 'fixed', environment_id: String(remote.id) },
      model_policy: {
        mode: 'fixed',
        model: {
          runtime: model.runtime,
          provider: model.provider,
          model_id: model.model_id,
          source: 'native',
        },
      },
    })
  }

  async function beginCase(testCase) {
    testCase.issue = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
      title: testCase.marker,
      description: `${testCase.marker}: preserve the complete final result across Runtime synchronization.`,
    })
    // Managed dispatch sends the Issue reference, not its title or description.
    // Register that identity before assignment can reach the mock model service.
    testCase.issue = await request(
      `/v1/loop-items/${testCase.issue.id}`,
      { version: testCase.issue.version, assignee_agent_id: agent.id },
      'PATCH'
    )
    testCase.execution = await until(
      async () =>
        (await request(`/v1/cloud-projects/${project.id}/executions?include_terminal=true`)).items,
      values =>
        values.find(
          row =>
            row.loopItemId === testCase.issue.id && row.status === 'running' && row.runtimeTaskId
        ),
      'Assignment did not start a real managed execution',
      modelResponseTimeoutMs
    )
    const initial = await until(
      () => rows(testCase),
      value =>
        value.activities.find(row => row.status === 'streaming' && row.content === testCase.prefix),
      'The real stream never persisted its partial prefix',
      modelResponseTimeoutMs
    )
    testCase.activityId = initial.message_id
    const taskId = testCase.execution.runtimeTaskId
    heldTasks.add(taskId)
    testCase.initialGate.resolve()
    testCase.terminal = await proxy.waitForEvent(
      entry => entry.event === 'response.completed' && entry.payload.taskId === taskId,
      { timeoutMs: modelResponseTimeoutMs }
    )
    assert.equal(testCase.terminal.held, true)
    assert.equal(testCase.terminal.deliveries, 0)
    assert.ok(Number(testCase.terminal.payload.eventSeq) > 0)
    const state = await rows(testCase)
    assert.equal(state.activities[0].content, testCase.prefix)
    assert.equal(state.activities[0].status, 'streaming')
    assert.equal(state.executions[0].status, 'running')
  }

  async function readSnapshot(testCase) {
    const address = { deviceId: REMOTE_DOCKER_DEVICE_ID, taskId: testCase.execution.runtimeTaskId }
    const transcript = await until(
      () =>
        rpc('runtime.tasks.transcript', { ...address, includeFullContent: true, refresh: true }),
      value =>
        !value.running &&
        value.turns?.some(turn =>
          TERMINAL.has(String(turn.runtimeStatus ?? turn.status).toLowerCase())
        ),
      'The real native session did not finish behind the transport gate',
      modelResponseTimeoutMs
    )
    assert.ok(
      JSON.stringify(transcript).includes(testCase.text),
      'Native history lost final output'
    )
    const snapshot = executionSnapshot(address, transcript)
    assert.ok(snapshot, 'The production projector rejected the native terminal transcript')
    assert.equal(snapshot.turns[0].id, testCase.terminal.payload.subtaskId)
    return snapshot
  }

  async function settleInOrder(testCase, snapshot) {
    const submit = () => emit('wework:project_chat:execution:snapshot', snapshot)
    if (testCase.order === 'snapshot-first') {
      const applied = await submit()
      assert.equal(applied.length, 1, 'The terminal snapshot did not reconcile its bound activity')
      const state = await rows(testCase)
      assert.equal(state.executions[0].status, 'completed')
      assert.equal(state.activities[0].status, 'completed')
      assert.equal(state.activities[0].content, testCase.prefix)
      assert.equal(testCase.terminal.deliveries, 0, 'Final event arrived before the snapshot')
      await proxy.release(testCase.terminal)
    } else if (testCase.order === 'event-first') {
      await proxy.release(testCase.terminal)
      await assertCompleted(testCase)
      await submit()
    } else {
      const lock = await holdDatabaseLock(
        cloud,
        'SELECT id FROM loop_item_executions WHERE id = %s FOR UPDATE',
        [testCase.execution.id]
      )
      const submissions = Promise.all([submit(), proxy.release(testCase.terminal)])
      void submissions.catch(() => {})
      try {
        const blocked = await lock.waitForBlockedQueries(2)
        evidence.push({ order: testCase.order, blockedTransactions: blocked.length })
      } finally {
        await lock.release()
        await submissions
      }
    }
    await assertCompleted(testCase)
  }

  async function assertCompleted(testCase) {
    const state = await until(
      () => rows(testCase),
      value =>
        value.executions[0]?.status === 'completed' &&
        value.activities.find(row => row.message_id === testCase.activityId)?.content ===
          testCase.text,
      'A terminal outcome lost the complete final activity text',
      uiTimeoutMs
    )
    const activity = state.activities.find(row => row.message_id === testCase.activityId)
    assert.equal(activity.status, 'completed')
    assert.equal(
      Number(state.executions[0].last_event_seq),
      Number(testCase.terminal.payload.eventSeq)
    )
    const persisted = (await messages(testCase)).find(row => row.messageId === testCase.activityId)
    assert.equal(
      persisted.content,
      testCase.text,
      'A fresh WS subscription must read the complete final text'
    )
    assert.equal(persisted.status, 'completed')
    return state
  }

  async function openIssue(control, testCase) {
    await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
    await control.command('waitFor', `${CONTENT} [data-testid="wework-collaboration-platform"]`)
    await selectCollaborationDomain(control, CONTENT, 'cloud')
    const toggle = `${CONTENT} [data-testid="collaboration-workspace-toggle-${workspace.id}"]`
    await control.command('waitFor', toggle)
    if ((await control.command('getAttribute', toggle, { value: 'aria-expanded' })) !== 'true')
      await control.command('click', toggle)
    await control.command(
      'click',
      `${CONTENT} [data-testid="collaboration-workspace-project-${project.id}"]`
    )
    await control.command('click', `${CONTENT} [data-testid="collaboration-tab-board"]`)
    const card = `${CONTENT} [data-testid="cloud-todo-card-${testCase.issue.id}"]`
    await control.command('waitFor', card)
    await control.command('click', card)
    await control.command('waitFor', `${CONTENT} [data-testid="cloud-task-activity-list"]`, {
      text: `${testCase.marker}_END`,
    })
  }

  async function verifyRefresh(control, testCase) {
    await openIssue(control, testCase)
    const card = `${CONTENT} [data-testid="cloud-task-activity-card-${testCase.activityId}"]`
    await control.command('waitFor', card, { text: `${testCase.marker}_END` })
    assert.ok(
      (await control.command('getText', card)).includes(testCase.text),
      'Electron truncated the final activity'
    )
    await reloadMainWindow(control, 'Electron did not reconnect after the reconciliation refresh')
    await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    // Read persisted activity again before reopening any Runtime transcript.
    await assertCompleted(testCase)
    await openIssue(control, testCase)
    await control.command('waitFor', card, { text: `${testCase.marker}_END` })
    assert.ok(
      (await control.command('getText', card)).includes(testCase.text),
      'Refreshing Electron lost the complete result'
    )
    await control.command('click', `${CONTENT} [data-testid="cloud-todo-detail-close"]`)
    // Fixed workspace tabs keep effects alive. The files view unmounts board cards,
    // whose transcript reads would otherwise submit uncontrolled Runtime snapshots.
    await control.command('click', `${CONTENT} [data-testid="collaboration-tab-files"]`)
    await until(
      () => control.command('getElementCount', `${CONTENT} [data-testid^="cloud-todo-card-"]`),
      count => Number(count) === 0,
      'The files view did not unmount the Runtime-reading board cards',
      uiTimeoutMs
    )
    evidence.push({
      order: testCase.order,
      taskId: testCase.execution.runtimeTaskId,
      finalCharacters: testCase.text.length,
      refreshed: true,
    })
  }

  async function capacity() {
    const native = await rpc('runtime.capacity.get', {})
    return { ...native, active_task_ids: [...native.active_task_ids].sort() }
  }

  async function beginContinuation(testCase) {
    heldTasks.delete(testCase.execution.runtimeTaskId)
    const trigger = await emit('wework:project_chat:message:send', {
      projectId: String(project.id),
      taskId: testCase.issue.id,
      clientMessageId: randomUUID(),
      content: testCase.continuePrompt,
      replyToMessageId: testCase.activityId,
      mentions: [],
    })
    await emit(
      'wework:project_chat:comment:execute',
      {
        projectId: String(project.id),
        taskId: testCase.issue.id,
        triggerMessageId: trigger.messageId,
      },
      modelResponseTimeoutMs
    )
    const next = await until(
      () => rows(testCase),
      value =>
        value.activities.find(
          row =>
            row.message_id !== testCase.activityId &&
            row.status === 'streaming' &&
            row.content === testCase.continuePrefix
        ),
      'A real continuation did not keep its own independent running activity',
      modelResponseTimeoutMs
    )
    testCase.nextActivityId = next.message_id
    const native = await rpc('runtime.tasks.transcript', {
      deviceId: REMOTE_DOCKER_DEVICE_ID,
      taskId: testCase.execution.runtimeTaskId,
      refresh: true,
    })
    assert.equal(native.running, true)
    await until(
      capacity,
      value =>
        value.active === 1 &&
        value.active_task_ids.length === 1 &&
        value.active_task_ids[0] === testCase.execution.runtimeTaskId,
      'The running continuation did not hold one real Executor slot',
      modelResponseTimeoutMs
    )
    return { state: await rows(testCase), capacity: await capacity() }
  }

  async function assertUnchangedContinuation(testCase, baseline, name) {
    assert.deepEqual(
      await rows(testCase),
      baseline.state,
      `${name} changed history, execution identity, Issue version or workflow state`
    )
    assert.deepEqual(
      await capacity(),
      baseline.capacity,
      `${name} released the running continuation's capacity`
    )
    const native = await rpc('runtime.tasks.transcript', {
      deviceId: REMOTE_DOCKER_DEVICE_ID,
      taskId: testCase.execution.runtimeTaskId,
      refresh: true,
    })
    assert.equal(native.running, true, `${name} ended the new native turn`)
    const persisted = await messages(testCase)
    assert.equal(
      persisted.find(row => row.messageId === testCase.activityId)?.content,
      testCase.text
    )
    const next = persisted.find(row => row.messageId === testCase.nextActivityId)
    assert.equal(next.status, 'streaming', `${name} ended the new activity`)
    assert.equal(next.content, testCase.continuePrefix, `${name} overwrote the new activity`)
    assert.equal(testCase.continueRequests, 1, `${name} restarted workflow model execution`)
    evidence.push({ staleEvent: name, newTurnRunning: true, slotsUsed: baseline.capacity.active })
  }

  async function verifyStaleTerminals(control, testCase) {
    const baseline = await beginContinuation(testCase)
    const sequence = Number(testCase.terminal.payload.eventSeq)
    const variants = [
      ['duplicate', {}],
      ['reordered', { eventSeq: sequence - 1 }],
      ['missing-sequence', { eventSeq: undefined, event_seq: undefined }],
      ['boolean-sequence', { eventSeq: true }],
      ['empty-content', { eventSeq: sequence + 1, data: {} }],
    ]
    try {
      for (const [name, overrides] of variants) {
        await proxy.replay(testCase.terminal, overrides)
        await assertUnchangedContinuation(testCase, baseline, name)
      }
    } finally {
      testCase.continueGate.resolve()
    }
    await until(
      () => messages(testCase),
      values =>
        values.find(
          row =>
            row.messageId === testCase.nextActivityId &&
            row.status === 'completed' &&
            row.content === testCase.continueText
        ),
      'The real continuation did not recover and finish after stale terminal delivery',
      modelResponseTimeoutMs
    )
    await until(
      capacity,
      value => value.active === 0 && value.active_task_ids.length === 0,
      'The completed native continuation did not release its slot',
      modelResponseTimeoutMs
    )
    // Verify the durable continuation after it settles. The running state is
    // asserted above against persisted runtime, workflow and capacity facts.
    await reloadMainWindow(control, 'Electron did not reconnect after the stale terminal checks')
    await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    await openIssue(control, testCase)
    const nextCard = `${CONTENT} [data-testid="cloud-task-activity-card-${testCase.nextActivityId}"]`
    await control.command('waitFor', nextCard, { text: testCase.continueText })
    await control.command('click', `${CONTENT} [data-testid="cloud-todo-detail-close"]`)
  }

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(environment) {
      backendUrl = environment.backendUrl
      authToken = environment.authToken
      await request('/admin/setup-complete', {})
      workspace = await request('/v1/workspaces', { name: `${MARKER}-workspace` })
      project = await request('/v1/cloud-projects', {
        workspace_id: workspace.id,
        name: `${MARKER}-project`,
        task_provider: 'local',
      })
    },
    setCloudEnvironment(environment) {
      cloud = environment
    },
    handleHttp: model.handleHttp,
    async verify(control) {
      socket = await connectSocket(backendUrl, authToken, uiTimeoutMs)
      await setupRemote()
      await setupAgent()
      await ensureExperimentalFeaturesEnabled(control)
      try {
        for (const testCase of cases) {
          await beginCase(testCase)
          const snapshot = await readSnapshot(testCase)
          await settleInOrder(testCase, snapshot)
          assert.equal(testCase.initialRequests, 1)
        }
        // Finish every controlled writer order before opening the fixture project.
        for (const testCase of cases) await verifyRefresh(control, testCase)
        await verifyStaleTerminals(control, cases.at(-1))
      } finally {
        model.release()
        await writeFile(
          join(resultDir, 'runtime-reconciliation-evidence.json'),
          JSON.stringify(
            {
              evidence,
              modelRequests: model.diagnostics(),
              heldEvents: proxy.events
                .filter(entry => entry.held)
                .map(entry => ({
                  event: entry.event,
                  taskId: entry.payload.taskId,
                  sequence: entry.payload.eventSeq,
                  deliveries: entry.deliveries,
                })),
            },
            null,
            2
          )
        )
      }
    },
    diagnostics: () => ({ evidence, modelRequests: model.diagnostics() }),
    async cleanup() {
      model.release()
      socket?.disconnect()
      await proxy?.stop()
    },
  }
}
