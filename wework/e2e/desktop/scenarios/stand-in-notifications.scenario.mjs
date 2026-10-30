import { verifyIssueAssignmentReceipts } from '../modules/issue-assignment-receipts.mjs'
import { openProjectStandIn } from '../modules/stand-in-flows.mjs'
import { verifyLocalStandInStatuses } from '../modules/stand-in-status-flows.mjs'
import { createStandInFailureRegression } from '../modules/stand-in-failure-notification.mjs'
import { createSubscriptionConfigRegression } from '../modules/stand-in-subscription-config.mjs'
import { verifyStandInArchiveRecovery } from '../modules/stand-in-archive-recovery.mjs'
import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { sendPrompt } from '../modules/conversation-navigation.mjs'
import {
  createLocalCollaborationProject,
  configureFirstProjectExecutionEnvironment,
} from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT = `分身通知-${process.pid}`
const MARKER = `STAND_IN_NOTIFICATION_${process.pid}`
const FOLLOW_UP = `${MARKER}_FOLLOW_UP`
const selector = id => `[data-testid=${JSON.stringify(id)}]`

async function assertInboxReady(control) {
  await control.command(
    'waitFor',
    '[data-testid="wework-notifications-collaboration-list"] [role="status"]',
    {
      visible: false,
    }
  )
  assert.equal(
    await control.command(
      'getElementCount',
      '[data-testid="wework-notifications-popover"] [role="alert"]'
    ),
    '0',
    'The real notification API must load without an error banner'
  )
}

export async function openStandInNotifications(control) {
  const entry = '[data-testid="wework-notifications-button"]'
  const category = '[data-testid="wework-notifications-category-collaboration"]'
  await control.command('waitFor', entry)
  await control.command('click', entry)
  await control.command('waitFor', category)
  await control.command('click', category)
}

export function createDesktopScenario({
  uiTimeoutMs,
  modelResponseTimeoutMs,
  captureScreenshot,
  workspacePath,
}) {
  const failureRegression = createStandInFailureRegression()
  const subscriptionRegression = createSubscriptionConfigRegression()
  let followUpResponse
  let userId
  return {
    requiresCloudEnvironment: true,
    async prepareCloud({ backendUrl, authToken }) {
      const response = await fetch(`${backendUrl}/api/users/me`, {
        headers: { Authorization: `Bearer ${authToken}` },
      })
      assert.equal(response.status, 200, 'The real backend must identify the current user')
      const user = await response.json()
      assert.ok(Number.isInteger(user.id) && user.id > 0)
      userId = user.id
    },
    prepareApp: subscriptionRegression.prepareApp,
    attachServer: subscriptionRegression.attachServer,
    cleanup: subscriptionRegression.cleanup,
    async handleHttp(request, response, url) {
      if (
        request.method !== 'POST' ||
        !['/responses', '/v1/responses', '/backend-api/codex/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      subscriptionRegression.acceptsModelRequest(request, url, body)
      if (failureRegression.handleHttp(body, response)) return true
      const id = `notification-${Date.now()}`
      const isFollowUp = JSON.stringify(body).includes(FOLLOW_UP)
      const result = isFollowUp ? '已按补充要求完成检查。' : '已完成任务，等待检查。'
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      const output = createSse([
        responseCreated(id),
        assistantMessage(result),
        responseCompleted(id),
      ])
      if (isFollowUp) followUpResponse = { response, output }
      else response.end(output)
      return true
    },
    async verify(control) {
      assert.ok(userId, 'The scenario must use its authenticated backend identity')
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      await configureFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)
      await control.command('click', `${CONTENT} [data-testid="collaboration-tab-board"]`)
      const projects = await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)
      const project = projects.find(row => row.name === PROJECT)
      assert.ok(project)
      await openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`, {
        connect: true,
      })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-auto"]')
      await control.command('waitFor', '[data-testid="stand-in-prompt"]')
      await control.command('fill', '[data-testid="stand-in-prompt"]', { value: MARKER })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
      const issue = await requestExecutor(
        control,
        'todos.create',
        {
          project_id: project.id,
          todo: { title: '在通知内继续处理分身任务', assignee_user_id: userId },
        },
        uiTimeoutMs
      )
      const deadline = Date.now() + modelResponseTimeoutMs
      let binding
      while (Date.now() < deadline) {
        const bindings = await requestExecutor(
          control,
          'todos.bindings',
          { task_id: issue.id },
          uiTimeoutMs
        )
        assert.ok(bindings.length <= 1, 'One assignment must own one stand-in task')
        if (bindings[0]) {
          const result = await requestExecutor(
            control,
            'runtime.tasks.get',
            { taskId: bindings[0].task_id },
            uiTimeoutMs
          )
          assert.notEqual(result.task?.status, 'failed', JSON.stringify(result))
          if (result.task?.status === 'done') {
            binding = bindings[0]
            break
          }
        }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      assert.ok(binding, 'Stand-in execution must finish')
      const id = `stand-in:${encodeURIComponent(`${binding.device_id}\0${binding.task_id}`)}`
      await openStandInNotifications(control)
      await control.command('waitFor', selector(`notification-processing-${id}`))
      await control.command('waitFor', selector(`notification-stand-in-status-${id}`), {
        text: '处理完毕',
      })
      await assertInboxReady(control)
      const notificationRow = selector(`wework-notification-${id}`)
      await control.command('waitFor', notificationRow, { text: '分身处理' })
      const rowText = await control.command('getText', notificationRow)
      assert.ok(rowText.includes('在通知内继续处理分身任务'))
      assert.ok(!rowText.includes('我的分身'), 'Handling must preserve the original title')
      assert.equal(
        await control.command('getElementCount', selector(`wework-notification-${id}-body`)),
        '0',
        'An assignment without an actor must keep the ordinary single-title layout'
      )
      assert.equal(
        await control.command(
          'getElementCount',
          selector(`notification-stand-in-reply-open-${id}`)
        ),
        '0',
        'Completed notifications must not restore the retired reply form'
      )
      await control.command('click', notificationRow)
      await control.command('waitFor', `${CONTENT} [data-testid="cloud-todo-detail-title"]`, {
        text: '在通知内继续处理分身任务',
      })
      await control.command('click', `${CONTENT} [data-testid="cloud-todo-detail-close"]`)
      await control.command('activateSystemNotification', 'body', {
        value: `wework://tasks/${encodeURIComponent(binding.device_id)}/${encodeURIComponent(binding.task_id)}`,
      })
      const composer = `${CONTENT} [data-active-workbench-pane="true"] [data-testid="chat-message-input"][contenteditable="true"]`
      await control.command('waitFor', composer)
      await sendPrompt(control, composer, FOLLOW_UP)
      const followUpDeadline = Date.now() + uiTimeoutMs
      while (!followUpResponse && Date.now() < followUpDeadline)
        await new Promise(resolve => setTimeout(resolve, 100))
      assert.ok(followUpResponse, 'The original session must receive the follow-up')
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      followUpResponse.response.end(followUpResponse.output)
      await openStandInNotifications(control)
      await control.command('waitFor', selector(`notification-processing-${id}`), {
        text: '已按补充要求完成检查。',
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', `${notificationRow}[data-unread="true"]`)
      const alerts = JSON.parse(await control.command('getSystemNotifications', 'body'))
      const completionAlert = alerts
        .filter(alert => alert.address?.taskId === binding.task_id)
        .at(-1)
      assert.ok(completionAlert, 'Completion must deliver its system notification')
      assert.equal(
        completionAlert.url,
        `wework://boards/local/${project.id}/issues/${issue.id}`,
        'Completion alerts must have the same Issue destination as the inbox entry'
      )
      await assertInboxReady(control)
      await captureScreenshot(
        control,
        'stand-in-completed-notification.png',
        '[data-testid="wework-notifications-popover"]'
      )
      assert.equal(
        await control.command('getElementCount', '[data-testid="wework-notifications-popover"]'),
        '1',
        'Completion remains available in the shared notification inbox'
      )
      assert.equal(
        alerts.filter(alert => alert.address?.taskId === binding.task_id).length,
        2,
        'Each completed turn must deliver exactly one alert, including after summary refresh'
      )

      const readyBeforeReload = control.readyCount
      await control.command('reloadApp', 'body')
      await control.awaitReadyAfter(readyBeforeReload)
      await openStandInNotifications(control)
      await control.command('waitFor', selector(`notification-stand-in-status-${id}`), {
        text: '处理完毕',
      })
      await control.command('waitFor', `${notificationRow}[data-unread="true"]`)
      const restoredAlerts = JSON.parse(await control.command('getSystemNotifications', 'body'))
      assert.equal(
        restoredAlerts.filter(alert => alert.address?.taskId === binding.task_id).length,
        0,
        'Restoring an unread completion must preserve the inbox entry without replaying its alert'
      )
      const bindings = await requestExecutor(
        control,
        'todos.bindings',
        { task_id: issue.id },
        uiTimeoutMs
      )
      assert.equal(bindings.length, 1)
      assert.equal(
        bindings[0].task_id,
        binding.task_id,
        'Follow-up must continue the original session'
      )
      await control.command('click', '[data-testid="wework-notifications-read-all"]')
      await control.command('waitFor', '[data-testid="wework-notifications-collaboration-list"]')

      // Exercise hit testing across the row after the duplicate inline form was retired.
      const row = `${selector(`notification-processing-${id}`)} [data-testid$="-container"]`
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('waitFor', '[data-testid="wework-notifications-popover"]', {
        visible: false,
      })
      for (const target of ['icon', 'edge', 'bottom', 'processing-space']) {
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await control.command('click', '[data-testid="wework-notifications-button"]')
        await control.command(
          'click',
          '[data-testid="wework-notifications-category-collaboration"]'
        )
        await control.command('waitFor', row)
        await control.command('waitFor', selector(`notification-stand-in-status-${id}`))
        const [bounds] = JSON.parse(await control.command('getElementMetrics', row))
        const [icon] = JSON.parse(await control.command('getElementMetrics', `${row} > span`))
        const [status] = JSON.parse(
          await control.command('getElementMetrics', selector(`notification-stand-in-status-${id}`))
        )
        assert.ok(bounds.width > 0 && bounds.height > 0, 'Notification row must be visible')
        const points = {
          icon: { x: icon.left + icon.width / 2, y: icon.top + icon.height / 2 },
          edge: { x: bounds.left + 2, y: bounds.top + bounds.height / 2 },
          bottom: { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height - 4 },
          'processing-space': {
            x: bounds.left + bounds.width - 20,
            y: status.top + status.height / 2,
          },
        }
        await control.command('clickAt', 'body', { value: JSON.stringify(points[target]) })
        await control.command('waitFor', '[data-testid="wework-notifications-popover"]', {
          visible: false,
        })
        await control.command('waitFor', `${CONTENT} [data-testid="cloud-todo-detail-title"]`)
        assert.equal(
          await control.command('getValue', `${CONTENT} [data-testid="cloud-todo-detail-title"]`),
          '在通知内继续处理分身任务',
          'Every notification hit target must open the original Issue'
        )
        await control.command('waitFor', `${CONTENT} [data-testid="cloud-todo-detail"]`, {
          text: issue.id,
        })
        await control.command('click', `${CONTENT} [data-testid="cloud-todo-detail-close"]`)
      }
      await control.command('activateSystemNotification', 'body', { value: completionAlert.url })
      await control.command('waitFor', `${CONTENT} [data-testid="cloud-todo-detail"]`, {
        text: issue.id,
      })
      await control.command('waitFor', `${CONTENT} [data-testid="cloud-todo-detail-title"]`)
      assert.equal(
        await control.command('getValue', `${CONTENT} [data-testid="cloud-todo-detail-title"]`),
        '在通知内继续处理分身任务'
      )
      await control.command('click', `${CONTENT} [data-testid="cloud-todo-detail-close"]`)
      await verifyIssueAssignmentReceipts(
        control,
        project.id,
        uiTimeoutMs,
        captureScreenshot,
        userId
      )
      await verifyLocalStandInStatuses(
        control,
        project.id,
        uiTimeoutMs,
        modelResponseTimeoutMs,
        userId
      )
      await failureRegression.verify(
        control,
        project.id,
        uiTimeoutMs,
        modelResponseTimeoutMs,
        userId
      )
      await verifyStandInArchiveRecovery(
        control,
        project.id,
        uiTimeoutMs,
        modelResponseTimeoutMs,
        userId
      )
      await subscriptionRegression.verify(
        control,
        project.id,
        workspacePath,
        uiTimeoutMs,
        modelResponseTimeoutMs,
        userId
      )
    },
  }
}
