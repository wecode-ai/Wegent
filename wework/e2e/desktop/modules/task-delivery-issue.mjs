import assert from 'node:assert/strict'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
} from './shared.mjs'
import { ensureExperimentalFeaturesEnabled } from './preferences-automation-flows.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const MARKER = 'WEWORK_TASK_DELIVERY_ISSUE'
const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const NOTES = '交付成功后直接展示关联 Issue 和交付内容'

export function createTaskDeliveryIssueRegression({
  workspacePath,
  modelResponseTimeoutMs,
  uiTimeoutMs,
}) {
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!JSON.stringify(body).includes(MARKER)) return false
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(MARKER),
          assistantMessage(`${MARKER} complete`),
          responseCompleted(MARKER),
        ])
      )
      return true
    },
    async verify(control, { project, issue }) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const existingDeliveryIds = new Set(
        (await rpc('deliveries.list', { item_id: issue.id })).map(delivery => delivery.id)
      )
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('navigate', 'body', { value: '/' })
      await createSingleRootLocalProject(control, workspacePath, 'Task delivery Issue')
      await selectE2EModel(control)
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: MARKER })
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        { text: `${MARKER} complete`, timeoutMs: modelResponseTimeoutMs }
      )
      const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot'))
      const task = snapshot.workbench?.currentRuntimeTask
      assert.ok(task?.deviceId && task.taskId, 'The real delivery task must exist')
      await rpc('todos.bind', {
        project_id: project.id,
        item_id: issue.id,
        task: { deviceId: task.deviceId, taskId: task.taskId },
      })
      await reloadMainWindow(control)
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        { text: `${MARKER} complete` }
      )
      if (
        Number(
          await control.command('getElementCount', '[data-testid="environment-info-popover"]', {
            visible: true,
          })
        ) === 0
      ) {
        await control.command('click', '[data-testid="environment-info-button"]', {
          visible: true,
        })
      }
      await control.command('waitFor', '[data-testid="environment-delivery-button"]')
      await control.command('click', '[data-testid="environment-delivery-button"]')
      await control.command('waitFor', '[data-testid="delivery-dialog"]')
      await control.command('click', '[data-testid="delivery-chat-none"]')
      await control.command('fill', '[data-testid="delivery-markdown"]', { value: NOTES })
      await control.command('click', '[data-testid="delivery-confirm"]')

      const drawer = `${CONTENT} .issue-drawer-detail`
      await control.command('waitFor', drawer, { text: issue.title })
      await control.command('waitFor', drawer, { text: NOTES })
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="delivery-dialog"]')),
        0
      )
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="delivery-complete-dialog"]')
        ),
        0
      )
      // Opening the delivered entry verifies that the drawer contains the persisted result.
      const newDeliveries = (await rpc('deliveries.list', { item_id: issue.id })).filter(
        delivery => !existingDeliveryIds.has(delivery.id)
      )
      assert.equal(newDeliveries.length, 1)
      const entry = `${drawer} [data-testid="todo-detail-open-delivery-${newDeliveries[0].id}"]`
      await control.command('click', entry)
      await control.command('waitFor', `${CONTENT} [data-testid="todo-detail-delivery-panel"]`, {
        text: NOTES,
      })
    },
  }
}
