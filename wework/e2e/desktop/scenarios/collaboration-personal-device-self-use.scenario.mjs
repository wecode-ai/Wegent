import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import { waitForValue } from '../modules/workspace-agent-setup.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const RESULT = `PERSONAL_DEVICE_SELF_USE_${process.pid}`

export function createDesktopScenario({ modelResponseTimeoutMs }) {
  let cloud
  let environment
  let project
  let issue
  let agent
  let modelRequests = 0

  async function request(path, body, authToken = cloud.authToken) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    const data = await response.json()
    assert.equal(response.ok, true, `${path}: ${response.status} ${JSON.stringify(data.detail)}`)
    return data
  }

  async function invoke(authToken) {
    const { io } = createRequire(
      new URL('../../../../packages/chat-core/package.json', import.meta.url)
    )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
    const socket = io(`${cloud.backendUrl}/wework-runtime`, {
      path: '/socket.io',
      transports: ['websocket'],
      auth: { token: authToken },
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      timeout: 10_000,
    })
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('connect_error', reject)
        socket.connect()
      })
      const scope = { projectId: String(project.id), taskId: String(issue.id) }
      const sent = await socket.timeout(10_000).emitWithAck('wework:project_chat:message:send', {
        ...scope,
        clientMessageId: randomUUID(),
        content: `@${agent.name} Return ${RESULT}`,
        mentions: [{ type: 'agent', id: String(agent.id), label: agent.name }],
      })
      assert.equal(sent.ok, true, sent.error?.message)
      const execution = await socket
        .timeout(10_000)
        .emitWithAck('wework:project_chat:comment:execute', {
          ...scope,
          triggerMessageId: sent.result.messageId,
        })
      assert.equal(execution.ok, true, execution.error?.message)
    } finally {
      socket.disconnect()
    }
  }

  const executions = () =>
    request(`/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`)

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(value) {
      cloud = value
      await request('/api/admin/setup-complete', {})
    },
    setCloudEnvironment(value) {
      environment = value
    },
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (
        !['prewarm', 'compaction'].includes(codexRequestKind(body)) &&
        JSON.stringify(body).includes(RESULT)
      )
        modelRequests += 1
      const id = randomUUID()
      const final = assistantMessage(RESULT)
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.end(createSse([responseCreated(id), final, responseCompleted(id, [final.item])]))
      return true
    },
    async verify() {
      const device = await environment.waitForConnectedAppDevice()
      const workspace = await request('/api/v1/workspaces', { name: RESULT })
      project = await request('/api/v1/cloud-projects', {
        name: RESULT,
        workspace_id: workspace.id,
      })
      const projectEnvironments = `/api/v1/cloud-projects/${project.id}/execution-environments`
      assert.deepEqual((await request(projectEnvironments)).items, [])
      assert.deepEqual(
        (await request(`/api/v1/workspaces/${workspace.id}/execution-environments`)).items,
        []
      )
      const catalog = await request(
        `/api/v1/resources/execution-environments?project_id=${project.id}`
      )
      const runner = catalog.find(item => item.id === String(device.id))
      assert.ok(runner, 'The owner must see their personal device without sharing')
      assert.equal(runner.project_authorized, false)
      const model = runner.models.find(item => item.runtime === 'codex')
      assert.ok(model, 'The real Executor must report its native model')
      agent = await request(`/api/v1/cloud-projects/${project.id}/chat-agents`, {
        name: RESULT,
        runtime: 'codex',
        executionMode: 'auto',
        systemPrompt: `Return ${RESULT}`,
        executionPolicy: { mode: 'fixed', environment_id: String(device.id) },
        modelPolicy: {
          mode: 'fixed',
          model: { runtime: model.runtime, provider: model.provider, model_id: model.model_id },
        },
        workspaceBinding: { type: 'standalone' },
        workspacePolicy: 'project',
        plugins: [],
      })
      issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, { title: RESULT })
      await invoke(cloud.authToken)
      const completed = await waitForValue(
        executions,
        value => value.items.length === 1 && value.items[0].status === 'completed',
        'The owner mention did not complete on the unshared device',
        modelResponseTimeoutMs
      )
      assert.equal(completed.items[0].runtimeDeviceId, device.execution_target_id)
      assert.equal(modelRequests, 1)
      assert.deepEqual(
        (await request(projectEnvironments)).items,
        [],
        'Personal use must not create project sharing grants'
      )
      assert.deepEqual(
        (await request(`/api/v1/workspaces/${workspace.id}/execution-environments`)).items,
        [],
        'Personal use must not share the device with the workspace'
      )

      const userName = `personal-device-member-${process.pid}`
      const password = 'personal-device-e2e-password'
      const member = await request('/api/admin/users', {
        user_name: userName,
        password,
        role: 'user',
        auth_source: 'password',
      })
      await request(`/api/v1/cloud-projects/${project.id}/members`, {
        user_id: member.id,
        role: 'Developer',
      })
      const login = await request('/api/auth/login', { user_name: userName, password })
      await invoke(login.access_token)
      const denied = await waitForValue(
        executions,
        value => value.items.find(item => item.status === 'failed'),
        'Another member must be denied the owners unshared device',
        10_000
      )
      assert.match(denied.errorMessage, /RUNNER_ENVIRONMENT_UNAVAILABLE/)
      assert.equal(modelRequests, 1, 'Another member must not start a model on the owners device')
    },
    diagnostics() {
      return { projectId: project?.id, issueId: issue?.id, modelRequests }
    },
  }
}
