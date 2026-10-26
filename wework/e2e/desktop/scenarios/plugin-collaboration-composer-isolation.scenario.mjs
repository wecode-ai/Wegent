import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  ACTIVE_COMPOSER_SELECTOR,
  BlockingNetworkProxy,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { installFixture, testId, until } from '../modules/plugin-regression-fixture.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'
import {
  currentRuntimeTaskFromDebugSnapshot,
  waitForWorkbenchDebugState,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const TASK_PANEL = '[data-testid="ai-chat-modal"]'
const PICKER = testId('composer-plugin-picker')
const PROMPT = 'PLUGIN_COLLABORATION_COMPOSER_FIXTURE'
const COMPLETION = 'PLUGIN_COLLABORATION_COMPOSER_READY'

function syntheticChatGptAuth() {
  const claims = Buffer.from(
    JSON.stringify({
      email: 'desktop-e2e@example.test',
      exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'desktop-e2e-account',
        chatgpt_plan_type: 'pro',
      },
    })
  ).toString('base64url')
  return {
    auth_mode: 'chatgpt',
    tokens: {
      account_id: 'desktop-e2e-account',
      access_token: 'desktop-e2e-access-token',
      refresh_token: 'desktop-e2e-refresh-token',
      id_token: `header.${claims}.signature`,
    },
    last_refresh: new Date().toISOString(),
  }
}

export async function createDesktopScenario({
  captureScreenshot,
  executorHome,
  modelResponseTimeoutMs,
  restartDesktopApp,
  workbenchReadyTimeoutMs,
  workspacePath,
}) {
  let cloud
  let cloudProxy
  let blockingNetworkProxy
  let fixture
  let boundTask
  let project
  let issue
  let issueTitle
  let cloudFaultEnabled = false
  const appEnvironment = {}

  async function request(path, body) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      ...(body ? { body: JSON.stringify(body) } : {}),
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
    })
    const text = await response.text()
    assert.ok(response.ok, `${path}: HTTP ${response.status}: ${text}`)
    return text ? JSON.parse(text) : null
  }

  async function createBoundTask(control) {
    await control.command('click', testId('workspace-tab-select-fixed-task'))
    await createSingleRootLocalProject(
      control,
      workspacePath,
      'collaboration-plugin-isolation',
      workbenchReadyTimeoutMs
    )
    await selectE2EModel(control)
    await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
      timeoutMs: workbenchReadyTimeoutMs,
      visible: true,
    })
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
    await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
    await control.command(
      'waitFor',
      '[data-testid="desktop-workbench-main"] [data-testid="message-assistant"]',
      { text: COMPLETION, timeoutMs: modelResponseTimeoutMs }
    )
    const debug = await waitForWorkbenchDebugState(
      control,
      snapshot => Boolean(currentRuntimeTaskFromDebugSnapshot(snapshot)?.taskId),
      'The local collaboration fixture did not create a runtime task',
      workbenchReadyTimeoutMs
    )
    const address = currentRuntimeTaskFromDebugSnapshot(debug)
    assert.ok(address?.deviceId && address.workspacePath)
    const workspace = await request('/api/v1/workspaces', {
      name: `Plugin isolation ${process.pid}`,
    })
    project = await request(`/api/v1/workspaces/${workspace.id}/projects`, {
      name: 'Plugin isolation project',
      project_key: `PLUGINISO${process.pid}`,
      task_provider: 'local',
      visibility: 'private',
    })
    issueTitle = 'Collaboration plugin isolation'
    issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
      title: issueTitle,
    })
    await request(`/api/v1/loop-items/${issue.id}/tasks`, {
      deviceId: address.deviceId,
      taskId: address.taskId,
      taskTitle: issueTitle,
      executionContext: { runtime: 'codex', workspacePath: address.workspacePath },
    })
    boundTask = (await request(`/api/v1/loop-items/${issue.id}/tasks`)).find(
      binding => binding.task_id === address.taskId
    )
    assert.ok(boundTask?.id)
  }

  async function openBoundTask(control) {
    await control.command('openWeworkScheme', 'body', {
      value: `wework://boards/${project.id}/issues/${issue.id}`,
    })
    const bindingButton = `${CONTENT} ${testId(`cloud-todo-open-task-conversation-${boundTask.id}`)}`
    await control.command('waitFor', bindingButton, {
      timeoutMs: workbenchReadyTimeoutMs,
      visible: true,
    })
    await control.command('clickWhenEnabled', bindingButton, {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    await control.command('waitFor', TASK_PANEL, {
      timeoutMs: workbenchReadyTimeoutMs,
      visible: true,
    })
  }

  async function assertPickerPlugin(control, timeoutMs = 20_000) {
    const pickerButton = `${TASK_PANEL} ${testId('composer-plugin-picker-button')}`
    await control.command('waitFor', pickerButton, {
      timeoutMs: workbenchReadyTimeoutMs,
      visible: true,
    })
    await control.command('click', pickerButton)
    await control.command('waitFor', PICKER, { timeoutMs: workbenchReadyTimeoutMs })
    const snapshot = await until(
      async () => JSON.parse(await control.command('snapshot', PICKER)),
      value =>
        value.testIds.includes(`composer-plugin-picker-item-plugin:${fixture.slug}`) &&
        !value.testIds.includes('composer-plugin-picker-error'),
      'Collaboration plugin picker did not recover its installed plugin',
      timeoutMs
    )
    assert.ok(snapshot.testIds.includes(`composer-plugin-picker-item-plugin:${fixture.slug}`))
    assert.ok(!snapshot.testIds.includes('composer-plugin-picker-error'))
    return snapshot
  }

  async function closePicker(control) {
    if (
      JSON.parse(await control.command('snapshot', 'body')).testIds.includes(
        'composer-plugin-picker'
      )
    ) {
      await control.command('click', `${TASK_PANEL} ${testId('composer-plugin-picker-button')}`)
      await control.command('waitFor', PICKER, { visible: false })
    }
  }

  return {
    appEnvironment,
    requiresCloudEnvironment: true,
    async prepareCloud(value) {
      cloud = value
      await request('/api/admin/setup-complete', {})
      cloudProxy = await new TransportFaultProxy(cloud.backendUrl).start()
      appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = cloudProxy.url
      cloudProxy.rule = entry =>
        cloudFaultEnabled && entry.method === 'GET' && entry.path === '/api/plugins/installed'
          ? 'drop-response'
          : null
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      await readRequestBody(request)
      const responseId = `plugin-collaboration-composer-${process.pid}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(responseId),
          assistantMessage(COMPLETION),
          responseCompleted(responseId),
        ])
      )
      return true
    },
    async verify(control) {
      const local = await cloud.waitForConnectedAppDevice()
      fixture = await installFixture(
        cloud,
        control,
        `collaboration-composer-${process.pid}`,
        local.device_id,
        workbenchReadyTimeoutMs
      )
      await createBoundTask(control)
      await openBoundTask(control)
      await assertPickerPlugin(control)
      await captureScreenshot(control, 'plugin-collaboration-composer-baseline.png', PICKER)

      // The cloud membership read is optional enrichment. Losing it must keep
      // the runtime's installed local plugin visible instead of blanking the picker.
      cloudFaultEnabled = true
      await closePicker(control)
      await assertPickerPlugin(control)
      await captureScreenshot(control, 'plugin-collaboration-composer-cloud-fault.png', PICKER)
      cloudFaultEnabled = false
      await closePicker(control)
      await assertPickerPlugin(control)

      // Hold Codex's remote app directory open. The executor must return local
      // plugins after its bounded remote deadline rather than hang or fail.
      blockingNetworkProxy = new BlockingNetworkProxy()
      await blockingNetworkProxy.start()
      const requestCount = blockingNetworkProxy.requests.length
      await control.command('storeLocalProxyUrl', 'body', { value: blockingNetworkProxy.url })
      await writeFile(
        join(executorHome, 'codex', 'auth.json'),
        `${JSON.stringify(syntheticChatGptAuth(), null, 2)}\n`,
        'utf8'
      )
      await restartDesktopApp()
      await openBoundTask(control)
      const blockedRequest = await until(
        async () =>
          blockingNetworkProxy.requests
            .slice(requestCount)
            .find(request => request.toLowerCase().includes('chatgpt.com')),
        Boolean,
        'Codex did not send its remote app directory through the blocking proxy',
        20_000
      )
      assert.match(blockedRequest, /chatgpt\.com/i)
      const degraded = await assertPickerPlugin(control, 20_000)
      assert.ok(
        degraded.testIds.includes(`composer-plugin-picker-item-plugin:${fixture.slug}`),
        'Remote app-directory timeout hid the installed collaboration plugin'
      )
      await captureScreenshot(control, 'plugin-collaboration-composer-remote-timeout.png', PICKER)
    },
    async cleanup() {
      cloudFaultEnabled = false
      blockingNetworkProxy?.release()
      await rm(join(executorHome, 'codex', 'auth.json'), { force: true })
      await cloudProxy?.stop()
      await blockingNetworkProxy?.stop()
    },
  }
}
