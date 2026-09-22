import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { CLOUD_PUBLIC_MODEL_NAME } from './shared.mjs'
import {
  assistantMessage,
  createSse,
  latestModelInputText,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const INITIAL = 'BOARD_REPLY_CLOUD_MODEL_INITIAL'
const INVALID_MODEL = 'BOARD_REPLY_CLOUD_MODEL_INVALID'
const REPLY = 'BOARD_REPLY_CLOUD_MODEL_CONTINUE'
const MEMBER_REPLY = 'BOARD_MEMBER_CONTINUE'
const PUBLIC_MODEL_ID = 'desktop-e2e-public-upstream-model'

async function requestJson(cloud, path, options = {}) {
  const response = await fetch(`${cloud.backendUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
  })
  const body = await response.json()
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${path} returned ${response.status}: ${JSON.stringify(body.detail)}`
  )
  return body
}

async function verifyMemberReply(cloud, issue, rootId) {
  const userName = `board-member-${process.pid}`
  const password = 'board-member-e2e-password'
  const member = await requestJson(cloud, '/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ user_name: userName, password, role: 'user', auth_source: 'password' }),
  })
  await requestJson(cloud, `/api/v1/cloud-projects/${cloud.projectId}/members`, {
    method: 'POST',
    body: JSON.stringify({ user_id: member.id, role: 'Developer' }),
  })
  const login = await requestJson(cloud, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ user_name: userName, password }),
  })
  const memberCloud = { ...cloud, authToken: login.access_token }
  const agents = await requestJson(
    memberCloud,
    `/api/v1/cloud-projects/${cloud.projectId}/chat-agents`
  )
  assert.ok(
    !agents.some(agent => agent.id === cloud.agentId),
    'The regression member must not see the admin-only agent'
  )
  const { io } = createRequire(
    new URL('../../../../packages/chat-core/package.json', import.meta.url)
  )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
  const socket = io(`${cloud.backendUrl}/wework-runtime`, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token: login.access_token },
    autoConnect: false,
    forceNew: true,
    reconnection: false,
  })
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('connect_error', reject)
      socket.connect()
    })
    const sent = await socket.timeout(10_000).emitWithAck('wework:project_chat:message:send', {
      projectId: cloud.projectId,
      taskId: issue.id,
      clientMessageId: crypto.randomUUID(),
      content: MEMBER_REPLY,
      replyToMessageId: rootId,
      mentions: [],
    })
    assert.equal(sent.ok, true)
    const execution = await socket
      .timeout(10_000)
      .emitWithAck('wework:project_chat:comment:execute', {
        projectId: cloud.projectId,
        taskId: issue.id,
        triggerMessageId: sent.result.messageId,
      })
    assert.equal(execution.ok, true, execution.error?.message)
    return memberCloud
  } finally {
    socket.disconnect()
  }
}

async function readPersistedExecutions(
  { backendUrl, authToken, projectId },
  taskId,
  prompts,
  timeoutMs,
  expectedStatus = null
) {
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
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ack = await socket.timeout(timeoutMs).emitWithAck('wework:project_chat:subscribe', {
        projectId,
        taskId,
        afterSequence: 0,
      })
      assert.equal(ack.ok, true, 'A new client must be able to read persisted execution states')
      const messages = ack.result.messages
      // Activity events persist identity and status; the runtime owns the transcript.
      const runs = prompts.map(prompt => {
        const trigger = messages.find(
          message => message.sender.type === 'user' && message.content === prompt
        )
        return trigger
          ? messages.find(
              message =>
                message.sender.type === 'agent' && message.triggerMessageId === trigger.messageId
            )
          : undefined
      })
      if (
        runs.every(
          message =>
            message &&
            (expectedStatus === 'failed' || message.runtimeAddress?.taskId) &&
            (!expectedStatus ||
              (message.status === expectedStatus && message.metadata.run_status === expectedStatus))
        )
      )
        return runs
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const cloud = { backendUrl, authToken }
    const [devices, executions] = await Promise.all([
      requestJson(cloud, '/api/devices/online'),
      requestJson(cloud, `/api/v1/cloud-projects/${projectId}/executions?include_terminal=true`),
    ])
    console.error(
      '[board-reply-model] Runtime delivery diagnostics',
      JSON.stringify({
        devices: devices.items.map(device => ({
          id: device.id,
          deviceId: device.device_id,
          type: device.device_type,
          instance: device.runtime_instance_id,
          used: device.slot_used,
          limit: device.slot_max,
        })),
        executions: executions.items.map(execution => ({
          id: execution.id,
          status: execution.status,
          deviceId: execution.executionDeviceId,
          runtimeDeviceId: execution.runtimeDeviceId,
          runtimeTaskId: execution.runtimeTaskId,
          approvalStatus: execution.approvalStatus,
          error: execution.errorMessage,
        })),
      })
    )
    assert.fail(`A fresh client could not read persisted executions for ${prompts.join(', ')}`)
  } finally {
    socket.disconnect()
  }
}

async function verifyExecutionDetail(control, scope, run, expectedText, timeoutMs) {
  const badge = scope(`[data-testid="cloud-task-activity-execution-badge-${run.messageId}"]`)
  await control.command('waitFor', badge, { timeoutMs })
  await control.command('click', badge)
  await control.command('waitFor', '[data-testid="runtime-execution-detail-body"]', {
    text: expectedText,
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="runtime-execution-detail-status"]', {
    text: '执行成功',
    timeoutMs,
  })
  const completedDialog = JSON.parse(
    await control.command('snapshot', '[data-testid="runtime-execution-detail-overlay"]')
  )
  assert.ok(
    !completedDialog.testIds.includes('runtime-execution-detail-stop'),
    'An execution confirmed as finished must not offer a stop action'
  )
  await control.command('click', '[data-testid="runtime-execution-detail-close"]')
  await control.command('waitFor', `${badge}[data-status="succeeded"]`, { timeoutMs })
  return badge
}

export function createBoardReplyModelRegression({ executorHome, uiTimeoutMs }) {
  let active = false
  const upstreamModels = new Map()

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/v1/responses', '/responses'].includes(url.pathname)
      ) {
        return false
      }
      const body = await readRequestBody(request)
      const text = latestModelInputText(body)
      const marker = text.includes(MEMBER_REPLY)
        ? MEMBER_REPLY
        : text.includes(REPLY)
          ? REPLY
          : text.includes(INITIAL)
            ? INITIAL
            : null
      if (marker) upstreamModels.set(marker, body.model)
      const id = `board-reply-model-${Date.now()}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          ...(marker ? [assistantMessage(`${marker}_DONE`)] : []),
          responseCompleted(id),
        ])
      )
      return true
    },

    async verify(control, issue, scope, cloud) {
      active = true
      try {
        const activity = scope(`[data-testid="cloud-task-activity-${issue.id}"]`)
        const composer = `${activity} [data-testid="cloud-task-activity-composer"]`
        const agents = await requestJson(
          cloud,
          `/api/v1/cloud-projects/${cloud.projectId}/chat-agents`
        )
        const agent = agents.find(item => item.id === cloud.agentId)
        assert.ok(agent, 'The configured agent must exist')
        const devices = await requestJson(cloud, '/api/devices/online')
        const device = devices.items.find(item => item.device_type === 'app')
        assert.ok(device, 'The real desktop executor must be registered')
        const environment = await requestJson(
          cloud,
          `/api/v1/cloud-projects/${cloud.projectId}/execution-environments`,
          { method: 'POST', body: JSON.stringify({ device_id: device.id }) }
        )
        assert.ok(
          environment.device_key,
          'The project execution environment must have a device key'
        )
        const configured = await requestJson(
          cloud,
          `/api/v1/cloud-projects/${cloud.projectId}/chat-agents/${agent.id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              version: agent.version,
              model: CLOUD_PUBLIC_MODEL_NAME,
              modelType: 'public',
              modelOptions: {},
              executionMode: 'auto',
              executionDeviceId: environment.device_key,
            }),
          }
        )
        await control.command('fill', composer, { value: INVALID_MODEL })
        await control.command('press', composer, { key: 'Enter' })
        const [failedRun] = await readPersistedExecutions(
          cloud,
          issue.id,
          [INVALID_MODEL],
          uiTimeoutMs,
          'failed'
        )
        assert.ok(
          JSON.stringify(failedRun).includes('Cloud model identity is incomplete'),
          'The execution must preserve the preflight failure reason'
        )
        const catalog = await requestJson(
          cloud,
          '/api/models/unified?scope=all&model_category_type=llm&client_origin=wework'
        )
        const model = catalog.data.find(
          item => item.name === CLOUD_PUBLIC_MODEL_NAME && item.type === 'public'
        )
        assert.ok(model?.namespace, 'The cloud model must expose its namespace')
        assert.equal(typeof model.resourceUserId, 'number')
        await requestJson(
          cloud,
          `/api/v1/cloud-projects/${cloud.projectId}/chat-agents/${agent.id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              version: configured.version,
              modelOptions: {
                weworkCloudModelNamespace: model.namespace,
                weworkCloudModelResourceUserId: String(model.resourceUserId),
              },
            }),
          }
        )
        await control.command('fill', composer, { value: INITIAL })
        await control.command('press', composer, { key: 'Enter' })
        const [initialRun] = await readPersistedExecutions(cloud, issue.id, [INITIAL], uiTimeoutMs)
        const initialBadge = await verifyExecutionDetail(
          control,
          scope,
          initialRun,
          `${INITIAL}_DONE`,
          uiTimeoutMs
        )

        const readTask = async taskId => {
          const index = JSON.parse(
            await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
          )
          return Object.values(index.tasks).find(task => task.local_task_id === taskId)
        }
        const original = await readTask(initialRun.runtimeAddress.taskId)
        assert.ok(original, 'The board comment did not create a persisted runtime task')
        assert.equal(original.runtime_handle.origin.loopItemId, issue.id)
        const selection = original.runtime_handle.modelSelection
        assert.equal(selection.modelName, CLOUD_PUBLIC_MODEL_NAME)
        assert.equal(selection.modelType, 'public')
        const rootId = original.runtime_handle.origin.rootCommentId
        assert.ok(rootId, 'The runtime task has no owning comment')
        assert.equal(rootId, initialRun.triggerMessageId)
        const reply = `${activity} [data-testid="cloud-task-activity-card-composer-${rootId}"]`
        await control.command('fill', reply, { value: REPLY })
        await control.command('press', reply, { key: 'Enter' })
        const [replyRun] = await readPersistedExecutions(cloud, issue.id, [REPLY], uiTimeoutMs)
        assert.deepEqual(replyRun.runtimeAddress, initialRun.runtimeAddress)
        await verifyExecutionDetail(control, scope, replyRun, `${REPLY}_DONE`, uiTimeoutMs)
        await control.command('waitFor', `${initialBadge}[data-status="succeeded"]`, {
          timeoutMs: uiTimeoutMs,
        })
        const continued = await readTask(original.local_task_id)
        assert.ok(continued, 'The original board runtime task disappeared after replying')
        assert.equal(continued.thread_id, original.thread_id)
        assert.deepEqual(continued.runtime_handle.modelSelection, selection)
        assert.equal(upstreamModels.get(INITIAL), PUBLIC_MODEL_ID)
        assert.equal(upstreamModels.get(REPLY), PUBLIC_MODEL_ID)
        const persisted = await readPersistedExecutions(
          cloud,
          issue.id,
          [INITIAL, REPLY],
          uiTimeoutMs,
          'completed'
        )
        assert.deepEqual(
          persisted.map(run => run.messageId),
          [initialRun.messageId, replyRun.messageId]
        )
        const memberCloud = await verifyMemberReply(cloud, issue, rootId)
        const [memberRun] = await readPersistedExecutions(
          memberCloud,
          issue.id,
          [MEMBER_REPLY],
          uiTimeoutMs,
          'completed'
        )
        assert.deepEqual(memberRun.runtimeAddress, initialRun.runtimeAddress)
        const transcript = await requestJson(memberCloud, '/api/runtime-work/transcript', {
          method: 'POST',
          body: JSON.stringify({
            ...memberRun.runtimeAddress,
            projectSession: { projectId: String(cloud.projectId), issueId: issue.id },
          }),
        })
        assert.equal(transcript.taskId, initialRun.runtimeAddress.taskId)
        assert.ok(transcript.turns.length > 0, 'A member must read the admin-owned session history')
        assert.equal(upstreamModels.get(MEMBER_REPLY), PUBLIC_MODEL_ID)
      } finally {
        active = false
      }
    },
  }
}
