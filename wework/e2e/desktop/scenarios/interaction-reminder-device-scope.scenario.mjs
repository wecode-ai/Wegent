import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import { waitForWindowState } from '../modules/native-window-state.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
  selectTool,
  toolOutputText,
} from '../modules/response-protocol.mjs'
import {
  CLOUD_DEVICE_ID,
  CLOUD_PUBLIC_MODEL_NAME,
  CLOUD_PUBLIC_MODEL_OPTIONS,
  DEFAULT_MODEL_ID,
  fetchJson,
} from '../modules/shared.mjs'

const REMOTE_FIRST_PROMPT = 'INTERACTION_REMINDER_SCOPE_REMOTE_FIRST'
const LOCAL_FIRST_PROMPT = 'INTERACTION_REMINDER_SCOPE_LOCAL_FIRST'
const REMOTE_SYSTEM_PROMPT = 'INTERACTION_REMINDER_SCOPE_REMOTE_SYSTEM'
const LOCAL_SYSTEM_PROMPT = 'INTERACTION_REMINDER_SCOPE_LOCAL_SYSTEM'
const REMOTE_FIRST_QUESTION = 'Should the remote review use the legacy policy?'
const LOCAL_FIRST_QUESTION = 'Should this device keep the current order policy?'
const REMOTE_SYSTEM_QUESTION = 'Should the remote background review keep the old policy?'
const LOCAL_SYSTEM_QUESTION = 'Should this device keep the policy in the background?'
const PENDING_TAB = '[data-testid="workspace-tab-select-pending-interactions"]'
const PENDING_PAGE = '[data-testid="runtime-interactions-page"]'
const INTERACTION_NOTICE = '[data-testid="runtime-interaction-notice"]'
const TASK_SYSTEM_SWITCH = '[data-testid="wework-notifications-setting-tasks-system"]'
const TASK_IN_APP_SWITCH = '[data-testid="wework-notifications-setting-tasks-in_app"]'

function pendingCountSelector(count) {
  return `${PENDING_TAB}[data-pending-question-count="${count}"]`
}

async function waitForValue(load, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastValue
  while (Date.now() < deadline) {
    try {
      lastValue = await load()
      if (predicate(lastValue)) return lastValue
    } catch (error) {
      lastValue = error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(
    `${message}: ${lastValue instanceof Error ? lastValue.message : JSON.stringify(lastValue)}`
  )
}

async function taskSystemNotifications(control) {
  return JSON.parse(await control.command('getSystemNotifications', 'body'))
}

async function assertNotificationsRemain(control, predicate, message, durationMs = 1000) {
  const deadline = Date.now() + durationMs
  do {
    const notifications = await taskSystemNotifications(control)
    if (!predicate(notifications)) throw new Error(`${message}: ${JSON.stringify(notifications)}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
}

async function assertElementCountRemains(control, selector, expected, message, durationMs = 1000) {
  const deadline = Date.now() + durationMs
  do {
    const count = Number(await control.command('getElementCount', selector))
    if (count !== expected) throw new Error(`${message}: found ${count} element(s)`)
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
}

async function enableTaskSystemNotifications(control) {
  await control.command('click', '[data-testid="wework-notifications-button"]')
  await control.command('click', '[data-testid="wework-notifications-settings"]')
  await control.command('waitFor', '[data-testid="wework-notifications-settings-panel"]')
  await control.command('waitFor', `${TASK_IN_APP_SWITCH}[aria-checked="true"]`)
  if (
    (await control.command('getAttribute', TASK_SYSTEM_SWITCH, { value: 'aria-checked' })) !==
    'true'
  )
    await control.command('click', TASK_SYSTEM_SWITCH)
  await control.command('waitFor', `${TASK_SYSTEM_SWITCH}[aria-checked="true"]`)
  await control.command('click', '[data-testid="wework-notifications-button"]')
}

function questionForPrompt(prompt) {
  return {
    [REMOTE_FIRST_PROMPT]: REMOTE_FIRST_QUESTION,
    [LOCAL_FIRST_PROMPT]: LOCAL_FIRST_QUESTION,
    [REMOTE_SYSTEM_PROMPT]: REMOTE_SYSTEM_QUESTION,
    [LOCAL_SYSTEM_PROMPT]: LOCAL_SYSTEM_QUESTION,
  }[prompt]
}

function interactionUrlPrefix(address) {
  return `wework://interactions/${encodeURIComponent(address.deviceId)}/${encodeURIComponent(address.taskId)}/`
}

export function createDesktopScenario({
  captureScreenshot,
  resultDir,
  executorHome,
  workspacePath,
  uiTimeoutMs,
}) {
  let cloud
  let remoteSequence = 0
  let localSequence = 0
  const heldQuestions = new Map()

  async function releaseHeldQuestion(prompt) {
    const held = await waitForValue(
      async () => heldQuestions.get(prompt) ?? null,
      Boolean,
      `The real Codex run never requested the ${prompt} question`,
      uiTimeoutMs * 3
    )
    held.response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    held.response.end(
      createSse([
        responseCreated(held.responseId),
        assistantMessage('The review is waiting for the required policy decision.'),
        ...selectedToolCall(held.callId, held.selection, 1),
        responseCompleted(held.responseId),
      ])
    )
    heldQuestions.delete(prompt)
  }

  async function createRemoteQuestion(prompt, title) {
    remoteSequence += 1
    const remoteWorkspace = join(
      cloud.runtimeWorkspaceRoot,
      `interaction-reminder-scope-${process.pid}-${remoteSequence}`
    )
    await mkdir(remoteWorkspace, { recursive: true })
    const modelSelection = {
      modelName: CLOUD_PUBLIC_MODEL_NAME,
      modelType: 'public',
      options: CLOUD_PUBLIC_MODEL_OPTIONS,
    }
    const task = await fetchJson(`${cloud.backendUrl}/api/runtime-work/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        deviceId: CLOUD_DEVICE_ID,
        workspacePath: remoteWorkspace,
        runtime: 'codex',
        message: prompt,
        title,
        modelId: CLOUD_PUBLIC_MODEL_NAME,
        modelType: 'public',
        modelOptions: CLOUD_PUBLIC_MODEL_OPTIONS,
        modelSelection,
      }),
    })
    assert.equal(task.accepted, true, `Remote interaction fixture was rejected: ${task.error}`)
    const address = {
      deviceId: task.deviceId,
      taskId: task.taskId,
      workspacePath: task.workspacePath,
    }
    assert.equal(address.deviceId, CLOUD_DEVICE_ID)
    await releaseHeldQuestion(prompt)
    await waitForValue(
      async () => {
        const work = await fetchJson(
          `${cloud.backendUrl}/api/runtime-work?pending_only=true&device_id=${encodeURIComponent(CLOUD_DEVICE_ID)}`,
          { headers: { Authorization: `Bearer ${cloud.authToken}` } }
        )
        const workspaces = [
          ...(work.projects ?? []).flatMap(project => project.deviceWorkspaces ?? []),
          ...(work.chats ?? []),
        ]
        return workspaces
          .flatMap(workspace => workspace.tasks ?? [])
          .find(candidate => candidate.taskId === address.taskId)
      },
      Boolean,
      `Remote question task ${address.taskId} never appeared in pending inventory`,
      uiTimeoutMs * 3
    )
    return address
  }

  async function createLocalQuestion(control, prompt, title) {
    localSequence += 1
    const catalog = await requestExecutor(control, 'runtime.runner.catalog', {}, uiTimeoutMs)
    const model = catalog.models.find(
      candidate => candidate.runtime === 'codex' && candidate.is_default
    )
    assert.ok(model, 'The local Codex model fixture is unavailable')
    const taskId = `interaction-reminder-local-${process.pid}-${localSequence}`
    const created = await requestExecutor(
      control,
      'runtime.tasks.create',
      {
        taskId,
        title,
        runtime: 'codex',
        workspacePath,
        message: prompt,
        clientUserMessageId: `${taskId}-initial`,
        executionRequest: {
          task_id: taskId,
          subtask_id: `${taskId}-initial`,
          user_id: 9001,
          prompt,
          new_session: true,
          bot: [{ shell_type: 'Codex', name: title }],
          model_config: { model_id: model.local_model_id, model_provider: model.provider },
        },
        modelSelection: {
          modelName: model.local_model_id,
          modelType: 'runtime',
          options: { runnerModelProvider: model.provider },
        },
      },
      uiTimeoutMs
    )
    assert.equal(created.accepted, true, 'The local interaction fixture was rejected')
    await releaseHeldQuestion(prompt)
    return { deviceId: created.deviceId, taskId, workspacePath }
  }

  async function verifyAliases(control) {
    const local = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
    const app = await cloud.waitForConnectedAppDevice()
    const expected = [
      local.deviceId,
      app.device_id,
      app.app_device_id,
      app.runtime_instance_id,
      app.execution_target_id,
      ...(app.runtime_routes ?? []).flatMap(route => [route.device_id, route.runtime_device_id]),
    ].filter(Boolean)
    const scope = await waitForValue(
      async () => JSON.parse(await control.command('getInteractionDeviceScope', 'body')),
      value =>
        value?.localDeviceIds?.length > 0 &&
        expected.every(id => value.localDeviceIds.includes(id)),
      'The current device aliases did not enter the interaction reminder scope',
      uiTimeoutMs
    )
    assert.ok(!scope.localDeviceIds.includes(CLOUD_DEVICE_ID))
    return { localDeviceId: local.deviceId, aliases: expected, scope: scope.localDeviceIds }
  }

  return {
    requiresCloudEnvironment: true,
    cloudModelCatalogOverrides: [DEFAULT_MODEL_ID, CLOUD_PUBLIC_MODEL_NAME].map(slug => ({
      slug,
      fields: { experimental_supported_tools: ['request_user_input_async'] },
    })),
    setCloudEnvironment(value) {
      cloud = value
    },
    async prepareApp() {
      const capabilities = join(executorHome, 'capabilities')
      await mkdir(capabilities, { recursive: true })
      await writeFile(
        join(capabilities, 'model-catalog-overrides.json'),
        JSON.stringify([
          {
            slug: DEFAULT_MODEL_ID,
            fields: { experimental_supported_tools: ['request_user_input_async'] },
          },
        ])
      )
      await rm(join(executorHome, 'codex', 'models_cache.json'), { force: true })
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const serialized = JSON.stringify(body)
      const prompt = [
        REMOTE_FIRST_PROMPT,
        LOCAL_FIRST_PROMPT,
        REMOTE_SYSTEM_PROMPT,
        LOCAL_SYSTEM_PROMPT,
      ].find(candidate => serialized.includes(candidate))
      if (!prompt) return false
      const callId = `interaction-reminder-call-${prompt}`
      const output = toolOutputText(body, callId)
      if (output !== null) {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(
          createSse([
            responseCreated(`interaction-reminder-${prompt}`),
            assistantMessage('The policy decision was accepted.'),
            responseCompleted(`interaction-reminder-${prompt}`),
          ])
        )
        return true
      }
      assert.equal(
        heldQuestions.has(prompt),
        false,
        `The same ${prompt} question was emitted twice`
      )
      heldQuestions.set(prompt, {
        callId,
        response,
        responseId: `interaction-reminder-${prompt}`,
        selection: selectTool(body, 'request_user_input_async', {
          questions: [{ title: questionForPrompt(prompt) }],
        }),
      })
      return true
    },
    async verify(control) {
      const aliasEvidence = await verifyAliases(control)
      await enableTaskSystemNotifications(control)
      await control.command('focusMainWindow', 'body')
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')

      const remoteFirst = await createRemoteQuestion(
        REMOTE_FIRST_PROMPT,
        'Remote review device-scope fixture'
      )
      await control.command('waitFor', pendingCountSelector(1), {
        timeoutMs: uiTimeoutMs * 4,
      })
      await assertElementCountRemains(
        control,
        INTERACTION_NOTICE,
        0,
        'A remote-only question produced an in-app reminder on the current device'
      )

      const localFirst = await createLocalQuestion(
        control,
        LOCAL_FIRST_PROMPT,
        'Local review device-scope fixture'
      )
      await control.command('waitFor', pendingCountSelector(2), {
        timeoutMs: uiTimeoutMs * 4,
      })
      await control.command('waitFor', INTERACTION_NOTICE, {
        text: LOCAL_FIRST_QUESTION,
        timeoutMs: uiTimeoutMs * 4,
      })
      assert.equal(
        (await control.command('getText', INTERACTION_NOTICE)).includes(REMOTE_FIRST_QUESTION),
        false
      )
      await control.command('click', PENDING_TAB)
      await control.command('waitFor', PENDING_PAGE, { text: REMOTE_FIRST_QUESTION })
      await control.command('waitFor', PENDING_PAGE, { text: LOCAL_FIRST_QUESTION })
      await control.command('waitFor', pendingCountSelector(2))
      await captureScreenshot(control, 'interaction-reminder-device-scope-in-app.png')

      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('clearSystemNotifications', 'body')
      await control.command('closeMainWindowToTray', 'body')
      await waitForWindowState(
        control,
        state => !state.visible,
        'The main window did not hide for system reminder verification',
        uiTimeoutMs
      )

      const remoteSystem = await createRemoteQuestion(
        REMOTE_SYSTEM_PROMPT,
        'Remote background device-scope fixture'
      )
      await control.command('waitFor', pendingCountSelector(3), {
        timeoutMs: uiTimeoutMs * 4,
      })
      await assertNotificationsRemain(
        control,
        notifications => notifications.length === 0,
        'A remote-only question produced a system reminder on the current device'
      )

      const localSystem = await createLocalQuestion(
        control,
        LOCAL_SYSTEM_PROMPT,
        'Local background device-scope fixture'
      )
      await control.command('waitFor', pendingCountSelector(4), {
        timeoutMs: uiTimeoutMs * 4,
      })
      const localSystemNotification = notifications => {
        if (notifications.length !== 1 || notifications[0].body !== LOCAL_SYSTEM_QUESTION)
          return false
        const prefix = interactionUrlPrefix(localSystem)
        return Boolean(
          notifications[0].url?.startsWith(prefix) && notifications[0].url.slice(prefix.length)
        )
      }
      const alerts = await waitForValue(
        () => taskSystemNotifications(control),
        localSystemNotification,
        'The local background question did not produce exactly one system reminder',
        uiTimeoutMs * 4
      )
      await assertNotificationsRemain(
        control,
        localSystemNotification,
        'The system reminder set changed after the local background question'
      )
      assert.equal(
        alerts.some(alert => alert.body === REMOTE_SYSTEM_QUESTION),
        false
      )

      await control.command('restoreMainWindow', 'body')
      await waitForWindowState(
        control,
        state => state.visible,
        'The main window did not restore after system reminder verification',
        uiTimeoutMs
      )
      await control.command('focusMainWindow', 'body')
      await control.command('click', PENDING_TAB)
      await control.command('waitFor', pendingCountSelector(4))
      await control.command('waitFor', PENDING_PAGE, { text: REMOTE_SYSTEM_QUESTION })
      await control.command('waitFor', PENDING_PAGE, { text: LOCAL_SYSTEM_QUESTION })
      await captureScreenshot(control, 'interaction-reminder-device-scope-background.png')
      await writeFile(
        join(resultDir, 'interaction-reminder-device-scope.json'),
        JSON.stringify(
          {
            aliasEvidence,
            remoteTasks: [remoteFirst.taskId, remoteSystem.taskId],
            localTasks: [localFirst.taskId, localSystem.taskId],
            alerts,
          },
          null,
          2
        )
      )
    },
  }
}
