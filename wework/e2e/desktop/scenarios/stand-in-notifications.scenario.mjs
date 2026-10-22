import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
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
const PROJECT = `替身通知-${process.pid}`
const MARKER = `STAND_IN_NOTIFICATION_${process.pid}`
const FOLLOW_UP = `${MARKER}_FOLLOW_UP`
const selector = id => `[data-testid=${JSON.stringify(id)}]`

export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs }) {
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      const id = `notification-${Date.now()}`
      const result = JSON.stringify(body).includes(FOLLOW_UP)
        ? '已按补充要求完成检查。'
        : '已完成任务，等待检查。'
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([responseCreated(id), assistantMessage(result), responseCompleted(id)])
      )
      return true
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      await configureFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)
      await control.command('click', `${CONTENT} [data-testid="collaboration-tab-board"]`)
      const projects = await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)
      const project = projects.find(row => row.name === PROJECT)
      assert.ok(project)
      await control.command('click', `${CONTENT} [data-testid="stand-in-open"]`)
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
          todo: { title: '在通知内继续处理替身任务', assignee_user_id: 9001 },
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
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      await control.command('waitFor', selector(`notification-processing-${id}`))
      await control.command('waitFor', selector(`notification-stand-in-status-${id}`), {
        text: '处理完毕',
      })
      await control.command('click', selector(`notification-stand-in-reply-open-${id}`))
      await control.command('fill', selector(`notification-stand-in-reply-${id}`), {
        value: FOLLOW_UP,
      })
      await control.command('clickWhenEnabled', selector(`notification-stand-in-send-${id}`))
      await control.command('waitFor', selector(`notification-processing-${id}`), {
        text: '已按补充要求完成检查。',
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.equal(
        await control.command('getElementCount', '[data-testid="wework-notifications-popover"]'),
        '1',
        'Inline follow-up must keep the notification open'
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

      // Exercise hit testing outside the title button and around inline controls.
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
        await control.command('waitFor', selector(`notification-stand-in-reply-open-${id}`))
        const [bounds] = JSON.parse(await control.command('getElementMetrics', row))
        const [icon] = JSON.parse(await control.command('getElementMetrics', `${row} > span`))
        const [reply] = JSON.parse(
          await control.command(
            'getElementMetrics',
            selector(`notification-stand-in-reply-open-${id}`)
          )
        )
        assert.ok(bounds.width > 0 && bounds.height > 0, 'Notification row must be visible')
        const points = {
          icon: { x: icon.left + icon.width / 2, y: icon.top + icon.height / 2 },
          edge: { x: bounds.left + 2, y: bounds.top + bounds.height / 2 },
          bottom: { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height - 4 },
          'processing-space': {
            x: bounds.left + bounds.width - 20,
            y: reply.top + reply.height / 2,
          },
        }
        await control.command('clickAt', 'body', { value: JSON.stringify(points[target]) })
        await control.command('waitFor', '[data-testid="wework-notifications-popover"]', {
          visible: false,
        })
        await control.command('waitFor', `${CONTENT} [data-testid="message-assistant"]`, {
          text: '已按补充要求完成检查。',
        })
      }
    },
  }
}
