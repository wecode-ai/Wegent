import assert from 'node:assert/strict'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import { waitForUnreadBadge } from '../modules/unread-badge.mjs'

const ACTIVE_WORKSPACE_TAB_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const ACTIVE_WORKBENCH_SELECTOR =
  `${ACTIVE_WORKSPACE_TAB_SELECTOR} ` +
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const TASK_SYSTEM_SWITCH = '[data-testid="wework-notifications-setting-tasks-system"]'
const PROMPTS = {
  foreground: 'WEWORK_E2E_TASK_NOTIFY_FOREGROUND',
  background: 'WEWORK_E2E_TASK_NOTIFY_BACKGROUND',
  disabled: 'WEWORK_E2E_TASK_NOTIFY_DISABLED',
}
const COMPLETIONS = {
  foreground: '前台完成，不应发送系统通知。',
  background: '后台完成，应发送一次系统通知。',
  disabled: '关闭系统通知后后台完成，不应发送通知。',
}
const NOTIFICATION_SETTLE_MS = 1200
const TASK_IN_APP_SWITCH = '[data-testid="wework-notifications-setting-tasks-in_app"]'

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

async function systemNotifications(control) {
  return JSON.parse(await control.command('getSystemNotifications', 'body'))
}

async function assertNotificationCount(
  control,
  count,
  message,
  durationMs = NOTIFICATION_SETTLE_MS
) {
  const deadline = Date.now() + durationMs
  let notifications
  do {
    notifications = await systemNotifications(control)
    assert.equal(notifications.length, count, `${message}: ${JSON.stringify(notifications)}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  notifications = await systemNotifications(control)
  assert.equal(notifications.length, count, `${message}: ${JSON.stringify(notifications)}`)
}

async function setTaskSystemNotifications(control, enabled) {
  await control.command('click', '[data-testid="wework-notifications-button"]')
  await control.command('click', '[data-testid="wework-notifications-settings"]')
  await control.command('waitFor', '[data-testid="wework-notifications-settings-panel"]')
  await control.command('waitFor', `${TASK_IN_APP_SWITCH}[aria-checked="true"]`)
  const checked = await control.command('getAttribute', TASK_SYSTEM_SWITCH, {
    value: 'aria-checked',
  })
  if ((checked === 'true') !== enabled) await control.command('click', TASK_SYSTEM_SWITCH)
  await control.command('waitFor', `${TASK_SYSTEM_SWITCH}[aria-checked="${enabled}"]`)
  await control.command('click', '[data-testid="wework-notifications-button"]')
}

async function waitForRendererFocus(control, focused, timeoutMs) {
  return waitForValue(
    () => control.command('getWindowFocusSnapshot', 'body').then(value => JSON.parse(value)),
    snapshot => snapshot.tracker?.focused === focused,
    `The workbench renderer did not become ${focused ? 'focused' : 'unfocused'}`,
    timeoutMs
  )
}

async function sendTask(control, newConversationSelector, prompt, timeoutMs) {
  await control.command('clickWhenEnabled', newConversationSelector, { timeoutMs })
  await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs })
  await control.command('fill', COMPOSER_SELECTOR, { value: prompt })
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]:enabled`,
    { timeoutMs }
  )
  await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
  const rowTestId = await waitForValue(
    async () => {
      const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKSPACE_TAB_SELECTOR))
      const rowTestIds = snapshot.testIds.filter(testId =>
        testId.startsWith('runtime-local-task-row-')
      )
      for (const testId of rowTestIds) {
        const text = await control.command(
          'getText',
          `${ACTIVE_WORKSPACE_TAB_SELECTOR} [data-testid="${testId}"]`
        )
        if (text.includes(prompt)) return testId
      }
      return null
    },
    Boolean,
    'The task row did not appear',
    timeoutMs
  )
  return {
    taskId: rowTestId.replace('runtime-local-task-row-', ''),
  }
}

async function waitForTaskSettled(control, prompt, completion, timeoutMs) {
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    { text: completion, timeoutMs }
  )
  return waitForValue(
    async () => JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')),
    snapshot => snapshot.pane?.status?.taskExecution?.running === false,
    `The task "${prompt}" did not settle`,
    timeoutMs
  )
}

function waitForModelRequest(streams, prompt, timeoutMs) {
  return waitForValue(
    () => streams.has(prompt),
    Boolean,
    `The ${prompt} model request was not received`,
    timeoutMs
  )
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
  let active = false
  const streams = new Map()
  const released = new Set()

  const release = prompt => {
    const stream = streams.get(prompt)
    if (!stream) throw new Error(`The ${prompt} model request was not received`)
    stream.response.end(
      createSse([assistantMessage(stream.completion), responseCompleted(stream.id)])
    )
    released.add(prompt)
  }

  return {
    requiresCloudEnvironment: true,

    async handleHttp(request, response, url) {
      if (!active || request.method !== 'POST') return false
      if (!['/responses', '/v1/responses'].includes(url.pathname)) return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const text = JSON.stringify(body)
      const promptKey = Object.keys(PROMPTS).find(key => text.includes(PROMPTS[key]))
      if (!promptKey) return false
      const prompt = PROMPTS[promptKey]
      if (streams.has(prompt)) throw new Error(`Duplicate model request for ${prompt}`)
      const id = `task-completion-notification-${streams.size + 1}`
      response.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      })
      response.flushHeaders()
      response.write(createSse([responseCreated(id)]))
      streams.set(prompt, { id, response, completion: COMPLETIONS[promptKey] })
      return true
    },

    async verify(control) {
      active = true
      await control.command('waitFor', '[data-testid="settings-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await createSingleRootLocalProject(control, workspacePath, 'task-completion-notifications')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await selectE2EModel(control)
      const projectSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const projectId = projectSnapshot.workbench?.currentProject?.id
      assert.ok(projectId, 'The notification project did not become active')
      const newConversationSelector =
        `${ACTIVE_WORKSPACE_TAB_SELECTOR} [data-testid="project-row-${projectId}"] ` +
        '[data-testid="project-new-conversation-button"]'
      await control.command('waitFor', newConversationSelector, { timeoutMs: uiTimeoutMs })

      await setTaskSystemNotifications(control, true)
      await control.command('clearSystemNotifications', 'body')
      await waitForUnreadBadge(control, 0, uiTimeoutMs)

      await control.command('focusMainWindow', 'body')
      await waitForRendererFocus(control, true, uiTimeoutMs)
      await sendTask(control, newConversationSelector, PROMPTS.foreground, uiTimeoutMs)
      await waitForModelRequest(streams, PROMPTS.foreground, uiTimeoutMs)
      await waitForRendererFocus(control, true, uiTimeoutMs)
      release(PROMPTS.foreground)
      await waitForTaskSettled(control, PROMPTS.foreground, COMPLETIONS.foreground, uiTimeoutMs)
      await assertNotificationCount(control, 0, 'A focused task completion must stay quiet')
      await waitForUnreadBadge(control, 0, uiTimeoutMs)

      const backgroundTask = await sendTask(
        control,
        newConversationSelector,
        PROMPTS.background,
        uiTimeoutMs
      )
      await waitForModelRequest(streams, PROMPTS.background, uiTimeoutMs)
      await control.command('blurMainWindow', 'body')
      await waitForRendererFocus(control, false, uiTimeoutMs)
      release(PROMPTS.background)
      await waitForTaskSettled(control, PROMPTS.background, COMPLETIONS.background, uiTimeoutMs)
      const notifications = await waitForValue(
        () => systemNotifications(control),
        items => items.length === 1,
        'The background completion did not send a system notification',
        uiTimeoutMs
      )
      assert.equal(notifications[0].address?.taskId, backgroundTask.taskId)
      await assertNotificationCount(control, 1, 'The background completion must notify once')
      await waitForUnreadBadge(control, 1, uiTimeoutMs, 1, backgroundTask.taskId)
      await control.command('focusMainWindow', 'body')
      await waitForRendererFocus(control, true, uiTimeoutMs)
      await waitForUnreadBadge(control, 0, uiTimeoutMs)
      await assertNotificationCount(control, 1, 'Refocusing must not notify again')

      await setTaskSystemNotifications(control, false)
      await control.command('clearSystemNotifications', 'body')
      const disabledTask = await sendTask(
        control,
        newConversationSelector,
        PROMPTS.disabled,
        uiTimeoutMs
      )
      await waitForModelRequest(streams, PROMPTS.disabled, uiTimeoutMs)
      await control.command('blurMainWindow', 'body')
      await waitForRendererFocus(control, false, uiTimeoutMs)
      release(PROMPTS.disabled)
      await waitForTaskSettled(control, PROMPTS.disabled, COMPLETIONS.disabled, uiTimeoutMs)
      await waitForUnreadBadge(control, 1, uiTimeoutMs, 1, disabledTask.taskId)
      await assertNotificationCount(control, 0, 'Disabled system notifications must stay quiet')
      await control.command('focusMainWindow', 'body')
      await waitForUnreadBadge(control, 0, uiTimeoutMs)
      await setTaskSystemNotifications(control, true)

      await captureScreenshot(control, 'task-completion-notifications-complete.png', 'body')
      active = false
    },

    diagnostics() {
      return { active, received: [...streams.keys()], released: [...released] }
    },
  }
}
