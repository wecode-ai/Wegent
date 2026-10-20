import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { REMOTE_DOCKER_DEVICE_ID } from '../modules/shared.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  reloadMainWindow,
  selectCollaborationDomain,
  configureFirstProjectExecutionEnvironment,
} from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const MARKER = `STAND_IN_CLOUD_${process.pid}`

async function until(load, accept, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await load()
    const result = accept(latest)
    if (result) return result === true ? latest : result
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

export function createDesktopScenario({
  uiTimeoutMs,
  modelResponseTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  let backendUrl
  let authToken
  let socket
  let requests = 0
  let agentRequests = 0
  let user
  let project
  let workspace
  let remote
  const request = async (path, body) => {
    const response = await fetch(`${backendUrl}/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
    const result = await response.json()
    assert.equal(response.ok, true, `${path}: ${JSON.stringify(result)}`)
    return result
  }
  const rpc = async (method, params) => {
    const ack = await socket.timeout(uiTimeoutMs).emitWithAck('runtime:request', {
      type: 'request',
      id: `${MARKER}-${method}`,
      method,
      params,
      device_id: REMOTE_DOCKER_DEVICE_ID,
      timeout_seconds: uiTimeoutMs / 1000,
    })
    assert.equal(ack.ok, true, `${method}: ${JSON.stringify(ack.error)}`)
    return ack.result
  }
  const settingsParams = () => ({
    projectId: String(project.id),
    userId: user.id,
    projectStore: 'cloud',
  })
  const createIssue = title =>
    request(`/v1/cloud-projects/${project.id}/loop-items`, {
      title,
      description: `${MARKER}，核对后直接回复结果。`,
      assignee_user_id: user.id,
    })
  const bindings = issue => request(`/v1/loop-items/${issue.id}/tasks`)

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      await request('/admin/setup-complete', {})
      user = await request('/users/me')
      workspace = await request('/v1/workspaces', { name: `${MARKER}-空间` })
      project = await request('/v1/cloud-projects', {
        workspace_id: workspace.id,
        name: `${MARKER}-项目`,
        task_provider: 'local',
      })
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      const text = JSON.stringify(body)
      if (text.includes(MARKER) && !['prewarm', 'compaction'].includes(codexRequestKind(body)))
        requests += 1
      if (
        text.includes(`${MARKER}_AGENT`) &&
        !['prewarm', 'compaction'].includes(codexRequestKind(body))
      )
        agentRequests += 1
      const id = `${MARKER}-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage('任务已核对，请检查结果。'),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      const { io } = createRequire(
        new URL('../../../../packages/chat-core/package.json', import.meta.url)
      )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
      socket = io(`${backendUrl}/wework-runtime`, {
        path: '/socket.io',
        transports: ['websocket'],
        auth: { token: authToken },
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        timeout: uiTimeoutMs,
      })
      try {
        await new Promise((resolve, reject) => {
          socket.once('connect', resolve)
          socket.once('connect_error', reject)
          socket.connect()
        })
        remote = await until(
          () => request('/devices/online'),
          result =>
            result.items.find(
              device => device.device_id === REMOTE_DOCKER_DEVICE_ID && device.status === 'online'
            ),
          workbenchReadyTimeoutMs,
          'Real remote Executor is offline'
        )
        const catalog = await rpc('runtime.runner.catalog', {})
        const model = catalog.models.find(row => row.runtime === 'codex' && row.is_default)
        assert.ok(model, 'Remote Executor has no native default Codex model')
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await selectCollaborationDomain(control, CONTENT, 'cloud')
        const toggle = `${CONTENT} [data-testid="collaboration-workspace-toggle-${workspace.id}"]`
        await control.command('waitFor', toggle)
        if (
          (await control.command('getAttribute', toggle, { value: 'aria-expanded' })) !== 'true'
        ) {
          await control.command('click', toggle)
        }
        await control.command(
          'click',
          `${CONTENT} [data-testid="collaboration-workspace-project-${project.id}"]`
        )
        await configureFirstProjectExecutionEnvironment(
          control,
          CONTENT,
          modelResponseTimeoutMs,
          remote.id
        )
        const agent = await request(`/v1/cloud-projects/${project.id}/chat-agents`, {
          name: '云端替身助手',
          runtime: 'codex',
          system_prompt: `${MARKER}_AGENT`,
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
        const historical = await createIssue('启用云端替身前已分配')
        await control.command('click', `${CONTENT} [data-testid="collaboration-tab-board"]`)
        await control.command('click', `${CONTENT} [data-testid="stand-in-open"]`)
        await control.command('waitFor', '[data-testid="stand-in-device"]')
        const currentDevice = await control.command('getValue', '[data-testid="stand-in-device"]')
        assert.ok(currentDevice)
        assert.notEqual(currentDevice, REMOTE_DOCKER_DEVICE_ID)
        await control.command('select', '[data-testid="stand-in-device"]', {
          value: REMOTE_DOCKER_DEVICE_ID,
        })
        await control.command('waitFor', '[data-testid="stand-in-auto"][aria-checked="false"]')
        await control.command(
          'waitFor',
          `[data-testid="stand-in-agent"] option[value="${agent.id}"]`
        )
        await control.command('select', '[data-testid="stand-in-agent"]', {
          value: String(agent.id),
        })
        await control.command('click', '[data-testid="stand-in-auto"]')
        await control.command('fill', '[data-testid="stand-in-prompt"]', { value: MARKER })
        await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
        await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
        const remoteSettings = await rpc('runtime.stand_in.get', settingsParams())
        assert.equal(remoteSettings.enabled, true)
        assert.equal(remoteSettings.executionDeviceId, REMOTE_DOCKER_DEVICE_ID)
        const localSettings = await requestExecutor(
          control,
          'runtime.stand_in.get',
          settingsParams(),
          uiTimeoutMs
        )
        assert.equal(
          localSettings.enabled,
          false,
          'Cloud configuration leaked into the desktop Executor'
        )
        await control.command('click', `${CONTENT} [data-testid="stand-in-open"]`)
        await control.command('waitFor', '[data-testid="stand-in-device"]')
        assert.equal(
          await control.command('getValue', '[data-testid="stand-in-device"]'),
          REMOTE_DOCKER_DEVICE_ID
        )
        await control.command('click', '[data-testid="stand-in-cancel"]')

        const issue = await createIssue('云端设备自动接手')
        const bound = await until(
          () => bindings(issue),
          rows => rows[0],
          modelResponseTimeoutMs,
          'Remote task was not bound'
        )
        assert.equal(bound.device_id, REMOTE_DOCKER_DEVICE_ID)
        await until(
          () => rpc('runtime.tasks.get', { taskId: bound.task_id }),
          result => {
            assert.notEqual(result.task?.status, 'failed', JSON.stringify(result))
            return result.task?.status === 'completed'
          },
          modelResponseTimeoutMs,
          'Remote task did not complete'
        )
        assert.equal(requests, 1)
        assert.equal(agentRequests, 1, 'The remote agent prompt did not reach its model')

        // Two real Executors may see one assignment; the existing work/start transition must arbitrate it.
        await requestExecutor(
          control,
          'runtime.stand_in.save',
          {
            ...settingsParams(),
            settings: { ...localSettings, enabled: true, prompt: MARKER },
          },
          uiTimeoutMs
        )
        const contested = await createIssue('两台设备看到同一分配')
        await until(
          () => bindings(contested),
          rows => rows.length > 0,
          modelResponseTimeoutMs,
          'Contested task was not created'
        )
        await until(
          async () => requests,
          count => count === 2,
          modelResponseTimeoutMs,
          'Contested assignment did not reach the model'
        )
        await new Promise(resolve => setTimeout(resolve, 11000))
        assert.equal(
          (await bindings(contested)).length,
          1,
          'Multiple devices created duplicate tasks'
        )
        assert.equal(requests, 2)
        assert.equal(
          (await bindings(historical)).length,
          0,
          'Enabling Stand-in backfilled a historical assignment'
        )
        await reloadMainWindow(control, 'Cloud Stand-in did not survive renderer reload')
        await control.command(
          'waitFor',
          `${CONTENT} [data-testid="stand-in-project-${project.id}"]`
        )
        const latest = await requestExecutor(
          control,
          'runtime.stand_in.get',
          settingsParams(),
          uiTimeoutMs
        )
        await requestExecutor(
          control,
          'runtime.stand_in.save',
          { ...settingsParams(), settings: { ...latest, enabled: false } },
          uiTimeoutMs
        )
        await rpc('runtime.stand_in.save', {
          ...settingsParams(),
          settings: { ...remoteSettings, enabled: false },
        })
      } finally {
        socket.disconnect()
      }
    },
    diagnostics() {
      return { projectId: project?.id, remoteDeviceId: remote?.device_id, requests, agentRequests }
    },
  }
}
