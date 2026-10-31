import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { requestExecutor } from './executor-rpc.mjs'
import { readProjectChatMessages } from './project-chat-snapshot.mjs'

/** Real persisted Issue comments and server-owned execution, with only the model mocked. */
export async function startHumanInteractionIssue({
  cloud,
  environment,
  control,
  prompt,
  timeoutMs,
}) {
  const request = async (path, body) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const value = await response.json()
    assert.ok(response.ok, `${path}: ${JSON.stringify(value)}`)
    return value
  }
  const device = await environment.waitForConnectedAppDevice()
  await request('/api/admin/setup-complete', {})
  const workspace = await request('/api/v1/workspaces', { name: `人工判断验证-${process.pid}` })
  await request(`/api/v1/workspaces/${workspace.id}/execution-environments`, {
    device_id: device.id,
  })
  let project = await request(`/api/v1/workspaces/${workspace.id}/projects`, {
    projectKey: 'DECISION',
    name: '订单兼容 Review',
    taskProvider: 'local',
    providerConfig: {},
    visibility: 'private',
  })
  await request(`/api/v1/cloud-projects/${project.id}/execution-environments`, {
    device_id: device.id,
  })
  project = await request(`/api/v1/cloud-projects/${project.id}`)
  await request(`/api/v1/cloud-projects/${project.id}/execution-environment/initialize`, {
    device_id: device.id,
    version: project.version,
  })
  const catalog = await requestExecutor(control, 'runtime.runner.catalog', {}, timeoutMs)
  const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
  assert.ok(model)
  const agent = await request(`/api/v1/cloud-projects/${project.id}/chat-agents`, {
    name: '订单 Review 助手',
    runtime: 'codex',
    systemPrompt: 'Review the order rules and ask the user for compatibility decisions.',
    visibility: 'creator_admin',
    executionMode: 'auto',
    executionPolicy: { mode: 'fixed', environment_id: String(device.id) },
    modelPolicy: {
      mode: 'fixed',
      model: { runtime: 'codex', provider: model.provider, model_id: model.local_model_id },
    },
    workspaceBinding: { type: 'standalone' },
    workspacePolicy: 'project',
    plugins: [],
  })
  const issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
    title: '判断旧客户订单兼容策略',
  })
  const { io } = createRequire(
    new URL('../../../../packages/chat-core/package.json', import.meta.url)
  )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
  const socket = io(`${cloud.backendUrl}/wework-runtime`, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token: cloud.authToken },
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
    const sent = await socket.timeout(timeoutMs).emitWithAck('wework:project_chat:message:send', {
      projectId: String(project.id),
      taskId: String(issue.id),
      clientMessageId: crypto.randomUUID(),
      content: prompt,
      mentions: [{ type: 'agent', id: String(agent.id), label: agent.name }],
    })
    assert.equal(sent.ok, true, sent.error?.message)
    const execution = await socket
      .timeout(timeoutMs)
      .emitWithAck('wework:project_chat:comment:execute', {
        projectId: String(project.id),
        taskId: String(issue.id),
        triggerMessageId: sent.result.messageId,
        runnerSelection: {
          execution_policy: { mode: 'fixed', environment_id: String(device.id) },
          model: { runtime: 'codex', provider: model.provider, model_id: model.local_model_id },
        },
      })
    assert.equal(execution.ok, true, execution.error?.message)
    return {
      ...cloud,
      projectId: String(project.id),
      issueId: String(issue.id),
      rootId: sent.result.messageId,
    }
  } finally {
    socket.disconnect()
  }
}

export async function verifyHumanInteractionIssueReply(fixture, answer, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let messages = []
  while (Date.now() < deadline) {
    messages = await readProjectChatMessages(fixture, fixture.issueId, timeoutMs)
    const replies = messages.filter(
      message => message.sender.type === 'user' && message.content === answer
    )
    assert.ok(replies.length <= 1, 'The decision must persist exactly once')
    const reply = replies[0]
    const original = messages.find(
      message => message.sender.type === 'agent' && message.triggerMessageId === fixture.rootId
    )
    const resumed =
      reply &&
      messages.find(
        message =>
          message.sender.type === 'agent' &&
          message.triggerMessageId === reply.messageId &&
          message.status === 'completed'
      )
    if (reply && resumed) {
      assert.equal(reply.rootMessageId, fixture.rootId)
      assert.equal(reply.replyToMessageId, fixture.rootId)
      assert.deepEqual(
        resumed.runtimeAddress,
        original.runtimeAddress,
        'The reply must continue the owning session'
      )
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`Issue continuation never completed: ${JSON.stringify(messages)}`)
}
