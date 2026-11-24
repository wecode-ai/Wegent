import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import { wireDeclarations } from '../modules/model-wire-contract.mjs'
import { runtimeTranscriptBlocks } from '../modules/runtime-transcript-evidence.mjs'
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
const REMOTE_ANSWER = 'Keep the current policy for the remote background review.'
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

function selectQuestionTool(body, question) {
  const names = wireDeclarations(body, 'responses')
    .map(tool => tool.name)
    .filter(Boolean)
  const name =
    names.find(candidate => candidate.endsWith('request_user_input_async')) ??
    names.find(candidate => candidate.endsWith('request_user_input')) ??
    'request_user_input_async'
  const argumentsValue = name.endsWith('_async')
    ? { questions: [{ title: question }] }
    : {
        questions: [
          {
            id: 'interaction_reminder_scope',
            header: 'Policy',
            question,
            options: [
              {
                label: 'Keep current',
                description: 'Keep the current policy for this review.',
              },
              {
                label: 'Use legacy',
                description: 'Use the legacy policy for this review.',
              },
            ],
          },
        ],
      }
  return selectTool(body, name, argumentsValue)
}

function interactionUrlPrefix(address) {
  return `wework://interactions/${encodeURIComponent(address.deviceId)}/${encodeURIComponent(address.taskId)}/`
}

export function hasPersistedInteractionAnswer(transcript, expected) {
  if (transcript.taskId !== expected.taskId) return false
  return runtimeTranscriptBlocks(transcript).some(block => {
    const payload = block.render_payload
    if (payload?.kind !== 'request_user_input') return false
    const question = payload.questions?.find(item => item.question === expected.question)
    if (!question) return false
    if (payload.delivery === 'async') {
      return transcript.messages.some(
        message => message.role === 'user' && message.content?.includes(expected.answer)
      )
    }
    const response = payload.response
    const answers = response?.answers?.[question.id]?.answers
    return (
      payload.interactionStatus === 'answered' &&
      response?.requestId === payload.requestId &&
      response?.itemId === payload.itemId &&
      response?.interactionScope === payload.interactionScope &&
      answers?.length === 1 &&
      answers[0] === expected.answer
    )
  })
}

export function assertRemoteQuestionCreated(task, device, workspacePath) {
  assert.equal(task.accepted, true, `Remote interaction fixture was rejected: ${task.error}`)
  assert.equal(task.deviceId, device.execution_target_id ?? device.device_id)
  assert.ok(task.taskId, 'The peer App did not return the created task identity')
  assert.equal(task.workspacePath, workspacePath)
}

export function createDesktopScenario({
  captureScreenshot,
  resultDir,
  executorHome,
  workspacePath,
  uiTimeoutMs,
}) {
  let cloud
  let remoteDevice
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
    const deviceId = remoteDevice.execution_target_id ?? remoteDevice.device_id
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
        deviceId,
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
    assertRemoteQuestionCreated(task, remoteDevice, remoteWorkspace)
    await releaseHeldQuestion(prompt)
    const address = await waitForValue(
      async () => {
        const work = await fetchJson(
          `${cloud.backendUrl}/api/runtime-work?pending_only=true&device_id=${encodeURIComponent(deviceId)}`,
          { headers: { Authorization: `Bearer ${cloud.authToken}` } }
        )
        const workspaces = [
          ...(work.projects ?? []).flatMap(project => project.deviceWorkspaces ?? []),
          ...(work.chats ?? []),
        ]
        for (const workspace of workspaces) {
          const pendingTask = workspace.tasks?.find(candidate => candidate.taskId === task.taskId)
          if (pendingTask) {
            return {
              deviceId: workspace.deviceId,
              taskId: pendingTask.taskId,
              ...(pendingTask.runtime !== 'codex' ? { runtime: pendingTask.runtime } : {}),
              workspacePath: pendingTask.workspacePath || workspace.workspacePath,
              ...(pendingTask.runtimeHandle ? { runtimeHandle: pendingTask.runtimeHandle } : {}),
            }
          }
        }
        return null
      },
      Boolean,
      `Remote question task ${task.taskId} never appeared in pending inventory`,
      uiTimeoutMs * 3
    )
    assert.equal(address.deviceId, deviceId)
    assert.equal(address.workspacePath, task.workspacePath)
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

  return {
    requiresCloudEnvironment: true,
    remoteExecutorType: 'app',
    cloudModelCatalogOverrides: [
      DEFAULT_MODEL_ID,
      CLOUD_PUBLIC_MODEL_NAME,
      'desktop-e2e-public-upstream-model',
    ].map(slug => ({
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
        selection: selectQuestionTool(body, questionForPrompt(prompt)),
      })
      return true
    },
    async verify(control) {
      const localDevice = await cloud.waitForConnectedAppDevice()
      remoteDevice = await waitForValue(
        async () =>
          (await cloud.devices()).find(
            candidate =>
              candidate.device_type === 'app' &&
              candidate.app_device_id === cloud.remoteExecutorEnv.WEGENT_APP_IPC_DEVICE_ID &&
              candidate.runtime_instance_id === cloud.remoteExecutorEnv.WEGENT_RUNTIME_INSTANCE_ID
          ),
        device =>
          device?.status === 'online' &&
          Boolean(device.execution_target_id ?? device.device_id) &&
          device.runtime_features?.remoteTaskAccess?.enabled === true &&
          device.runtime_features.remoteTaskAccess.taskCreation === true,
        'The peer App installation did not advertise its locally enabled remote task access',
        uiTimeoutMs * 4
      )
      assert.notEqual(remoteDevice.runtime_instance_id, localDevice.runtime_instance_id)
      assert.notEqual(remoteDevice.app_device_id, localDevice.app_device_id)
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
      await control.command('waitFor', INTERACTION_NOTICE, {
        text: REMOTE_FIRST_QUESTION,
        timeoutMs: uiTimeoutMs * 4,
      })
      await control.command('click', '[data-testid="interaction-notice-dismiss"]')

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
      await control.command('click', '[data-testid="interaction-notice-dismiss"]')
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
      const matchesNotification = (notification, address, question) => {
        const prefix = interactionUrlPrefix(address)
        return Boolean(
          notification.body === question &&
          notification.url?.startsWith(prefix) &&
          notification.url.slice(prefix.length)
        )
      }
      await waitForValue(
        () => taskSystemNotifications(control),
        notifications =>
          notifications.length === 1 &&
          matchesNotification(notifications[0], remoteSystem, REMOTE_SYSTEM_QUESTION),
        'The remote background question did not produce exactly one routed system reminder',
        uiTimeoutMs * 4
      )

      const localSystem = await createLocalQuestion(
        control,
        LOCAL_SYSTEM_PROMPT,
        'Local background device-scope fixture'
      )
      await control.command('waitFor', pendingCountSelector(4), {
        timeoutMs: uiTimeoutMs * 4,
      })
      const completeNotificationSet = notifications =>
        notifications.length === 2 &&
        notifications.filter(notification =>
          matchesNotification(notification, remoteSystem, REMOTE_SYSTEM_QUESTION)
        ).length === 1 &&
        notifications.filter(notification =>
          matchesNotification(notification, localSystem, LOCAL_SYSTEM_QUESTION)
        ).length === 1
      const alerts = await waitForValue(
        () => taskSystemNotifications(control),
        completeNotificationSet,
        'The remote and local questions did not each produce exactly one system reminder',
        uiTimeoutMs * 4
      )
      await assertNotificationsRemain(
        control,
        completeNotificationSet,
        'A pending question produced a duplicate system reminder'
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
      const remoteAlert = alerts.find(notification =>
        matchesNotification(notification, remoteSystem, REMOTE_SYSTEM_QUESTION)
      )
      await control.command('activateSystemNotification', 'body', { value: remoteAlert.url })
      await control.command(
        'waitFor',
        `${PENDING_PAGE} section:has([data-testid="interaction-question-heading"]) p`,
        {
          text: REMOTE_SYSTEM_QUESTION,
        }
      )
      await control.command(
        'clickWhenEnabled',
        `${PENDING_PAGE} [data-testid="interaction-show-context"]`
      )
      const input = `${PENDING_PAGE} [data-testid^="request-user-input-custom-"]:not(:disabled)`
      await control.command('waitFor', input, { timeoutMs: uiTimeoutMs * 4 })
      await control.command('fill', input, { value: REMOTE_ANSWER })
      await control.command(
        'clickWhenEnabled',
        `${PENDING_PAGE} [data-testid="request-user-input-submit-button"]`
      )
      await control.command('waitFor', pendingCountSelector(3), {
        timeoutMs: uiTimeoutMs * 4,
      })
      const answeredTranscript = await waitForValue(
        () =>
          fetchJson(`${cloud.backendUrl}/api/runtime-work/transcript`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cloud.authToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(remoteSystem),
          }),
        transcript =>
          hasPersistedInteractionAnswer(transcript, {
            taskId: remoteSystem.taskId,
            question: REMOTE_SYSTEM_QUESTION,
            answer: REMOTE_ANSWER,
          }),
        'The remote Runtime did not persist the answer submitted from this device',
        uiTimeoutMs * 4
      )
      await writeFile(
        join(resultDir, 'interaction-reminder-device-scope.json'),
        JSON.stringify(
          {
            remoteDevice: {
              deviceId: remoteDevice.execution_target_id ?? remoteDevice.device_id,
              appDeviceId: remoteDevice.app_device_id,
              runtimeInstanceId: remoteDevice.runtime_instance_id,
              remoteTaskAccess: remoteDevice.runtime_features.remoteTaskAccess,
            },
            remoteTasks: [remoteFirst.taskId, remoteSystem.taskId],
            localTasks: [localFirst.taskId, localSystem.taskId],
            alerts,
            answeredRemoteTask: answeredTranscript.taskId,
          },
          null,
          2
        )
      )
    },
  }
}
