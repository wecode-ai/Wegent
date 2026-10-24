import assert from 'node:assert/strict'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import { createLocalCollaborationProject } from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const COMPOSER = `${ACTIVE} [data-active-workbench-pane="true"] [data-testid="chat-message-input"][contenteditable="true"]`
const PROMPT = 'NOTIFICATION_TAB_NAVIGATION'
const COMPLETION = 'NOTIFICATION_TAB_NAVIGATION_COMPLETE'
const selector = id => `[data-testid=${JSON.stringify(id)}]`

async function waitFor(control, read, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let actual
  while (Date.now() < deadline) {
    actual = await read(control)
    if (predicate(actual)) return actual
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(actual)}`)
}

export function createDesktopScenario({ workspacePath, uiTimeoutMs, modelResponseTimeoutMs }) {
  let pendingResponse
  const responseId = 'notification-tab-navigation'
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(JSON.stringify(body).includes(PROMPT), 'Unexpected model request')
      assert.equal(pendingResponse, undefined, 'The task must launch exactly once')
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.write(createSse([responseCreated(responseId)]))
      pendingResponse = response
      return true
    },
    async verify(control) {
      await createSingleRootLocalProject(control, workspacePath, 'notification-tab-navigation')
      await selectE2EModel(control)
      const taskTab = await control.command('getAttribute', '[role="tab"][aria-selected="true"]', {
        value: 'data-testid',
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      const projectName = 'Notification navigation source'
      await createLocalCollaborationProject(control, ACTIVE, projectName)
      const boardTab = await control.command('getAttribute', '[role="tab"][aria-selected="true"]', {
        value: 'data-testid',
      })
      const source = JSON.parse(await control.command('snapshot', 'body'))
      const boardLocation = source.location
      assert.ok(
        new URL(boardLocation).searchParams.get('projectId'),
        'The source must open a project'
      )
      const tabsBefore = source.testIds.filter(id => id.startsWith('workspace-tab-select-')).sort()
      await control.command('click', selector(taskTab))
      await control.command('fill', COMPOSER, { value: PROMPT })
      await control.command('press', COMPOSER, { key: 'Enter' })
      const address = await waitFor(
        control,
        async () =>
          JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).workbench
            ?.currentRuntimeTask,
        value => value?.deviceId && value?.taskId && pendingResponse,
        'The real runtime task did not start',
        modelResponseTimeoutMs
      )
      const openBoard = async () => {
        await control.command('click', selector(boardTab))
        await control.command('waitFor', `${ACTIVE} [data-testid="cloud-project-header-title"]`, {
          text: projectName,
        })
        const current = JSON.parse(await control.command('snapshot', 'body'))
        assert.equal(
          current.location,
          boardLocation,
          'Navigation replaced the source project route'
        )
      }
      const assertTask = async () => {
        await control.command('waitFor', `${selector(taskTab)}[aria-selected="true"]`)
        const current = await waitFor(
          control,
          async () =>
            JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).workbench
              ?.currentRuntimeTask,
          value => value?.deviceId === address.deviceId && value?.taskId === address.taskId,
          'The selected task tab did not restore the target conversation',
          uiTimeoutMs
        )
        assert.equal(current?.deviceId, address.deviceId)
        assert.equal(current?.taskId, address.taskId)
        const tabs = JSON.parse(await control.command('snapshot', 'body'))
          .testIds.filter(id => id.startsWith('workspace-tab-select-'))
          .sort()
        assert.deepEqual(tabs, tabsBefore, 'Navigation must reuse the existing task tab')
      }

      await openBoard()
      const menuItemId = `task:${encodeURIComponent(address.deviceId)}:${encodeURIComponent(address.taskId)}`
      await waitFor(
        control,
        async () => JSON.parse(await control.command('getTraySnapshot', 'body')),
        value => JSON.stringify(value.menu).includes(menuItemId),
        'The running task was not registered in the native tray',
        uiTimeoutMs
      )
      assert.equal(
        JSON.parse(
          await control.command('activateTray', 'body', {
            value: JSON.stringify({ type: 'menu-item', menuItemId }),
          })
        ),
        true
      )
      await assertTask()

      await openBoard()
      pendingResponse.end(createSse([assistantMessage(COMPLETION), responseCompleted(responseId)]))
      await control.command('waitFor', '[data-testid="wework-notifications-unread"]', {
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-category-tasks"]')
      await control.command('click', selector(`wework-notification-task-${address.taskId}`))
      await assertTask()
      await control.command('waitFor', `${ACTIVE} [data-testid="message-assistant"]`, {
        text: COMPLETION,
      })
      await control.command('waitFor', '[data-testid="wework-notifications-unread"]', {
        visible: false,
      })

      await openBoard()
      await control.command('activateRuntimeTaskCompletionNotification', 'body', {
        value: JSON.stringify(address),
      })
      await assertTask()
      await openBoard()
    },
    diagnostics() {
      return {
        taskStarted: Boolean(pendingResponse),
        taskCompleted: pendingResponse?.writableEnded,
      }
    },
  }
}
