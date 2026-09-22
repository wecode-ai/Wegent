import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import {
  completeLocalCollaborationFolderImport,
  inCollaborationSidebar,
} from '../modules/workspace-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const LOCAL_WORKSPACE_ID = 'wework-local-workspace'
const PROJECT_NAME = `首次协作验收-${process.pid}`
const ISSUE_NAME = `整理首用闭环-${process.pid}`
const RUN_MARKER = 'COLLABORATION_FIRST_USE_ASSISTANT'
const COMPLETION_MARKER = 'COLLABORATION_FIRST_USE_COMPLETED'
const DEFAULT_AGENT_NAME = '当前设备助手'

function scoped(selector) {
  return `${ACTIVE_WORKBENCH_SELECTOR} ${selector}`
}

function sidebarScoped(selector) {
  return inCollaborationSidebar(selector)
}

async function waitForValue(read, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastValue
  while (Date.now() < deadline) {
    lastValue = await read()
    if (predicate(lastValue)) return lastValue
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.fail(`${message}. Last value: ${JSON.stringify(lastValue)}`)
}

export function createDesktopScenario({
  captureScreenshot,
  modelResponseTimeoutMs,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  let active = false
  let verifiedRequest = null
  let defaultAgentId = null
  const capture = (control, name, selector = ACTIVE_WORKBENCH_SELECTOR) =>
    captureScreenshot(control, name, selector)

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      ) {
        return false
      }
      const body = await readRequestBody(request)
      if (!JSON.stringify(body).includes(RUN_MARKER)) return false
      verifiedRequest = body
      const responseId = `collaboration-first-use-${Date.now()}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(responseId),
          assistantMessage(COMPLETION_MARKER),
          responseCompleted(responseId),
        ])
      )
      return true
    },

    async verify(control) {
      active = true
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', sidebarScoped('[data-testid="collaboration-primary-agents"]'))
      await control.command('waitFor', scoped('[data-testid="collaboration-agents-page"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid^="collaboration-agents-row-"]'), {
        text: DEFAULT_AGENT_NAME,
        timeoutMs: uiTimeoutMs,
      })
      const agentSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
      const defaultAgentRowTestId = agentSnapshot.testIds.find(testId =>
        testId.startsWith('collaboration-agents-row-')
      )
      assert.ok(defaultAgentRowTestId, 'The first-use default Agent was not created')
      defaultAgentId = defaultAgentRowTestId.slice('collaboration-agents-row-'.length)
      await capture(control, 'collaboration-first-use-00-default-agent.png')

      await control.command('click', sidebarScoped('[data-testid="collaboration-primary-home"]'))
      await control.command(
        'waitFor',
        scoped('[data-testid="collaboration-first-project-starter"]'),
        {
          text: '开始第一个协作项目',
          timeoutMs: uiTimeoutMs,
        }
      )
      await capture(control, 'collaboration-first-use-01-welcome.png')

      await control.command('click', scoped('[data-testid="collaboration-first-project-create"]'))
      await control.command(
        'waitFor',
        scoped(`[data-testid="collaboration-project-workspace-${LOCAL_WORKSPACE_ID}"]`),
        { timeoutMs: uiTimeoutMs }
      )
      await capture(control, 'collaboration-first-use-02-workspace.png')
      await control.command(
        'click',
        scoped(`[data-testid="collaboration-project-workspace-${LOCAL_WORKSPACE_ID}"]`)
      )
      await completeLocalCollaborationFolderImport(control, PROJECT_NAME)
      await control.command('waitFor', scoped('[data-testid="collaboration-empty-project"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await capture(control, 'collaboration-first-use-03-project.png')

      await control.command('click', scoped('[data-testid="collaboration-empty-project-create"]'))
      await control.command('waitFor', scoped('[data-testid="cloud-todo-title"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
        value: ISSUE_NAME,
      })
      await capture(control, 'collaboration-first-use-04-issue.png')
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="cloud-todo-create-confirm"]'),
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', scoped('[data-testid="cloud-todo-default-assistant"]'), {
        text: '本机助手',
        timeoutMs: uiTimeoutMs,
      })
      await capture(control, 'collaboration-first-use-05-assistant.png')

      await control.command('click', scoped('[data-testid="cloud-todo-start-default-assistant"]'))
      const taskPanel = scoped('[data-testid="work-item-new-task-chat-panel"]')
      const composer = `${taskPanel} [data-testid="chat-message-input"]`
      await control.command('waitFor', taskPanel, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', composer, { timeoutMs: uiTimeoutMs })
      await selectE2EModel(control, undefined, undefined, taskPanel)
      await capture(control, 'collaboration-first-use-06-composer.png')

      await control.command('fill', composer, {
        value: `${RUN_MARKER} 完成当前 Issue，并明确回复执行结果。`,
      })
      await control.command('press', composer, { key: 'Enter' })
      await control.command(
        'waitFor',
        scoped('[data-testid="work-item-task-chat-panel"] [data-testid="message-assistant"]'),
        {
          text: COMPLETION_MARKER,
          timeoutMs: modelResponseTimeoutMs,
        }
      )
      assert.ok(verifiedRequest, 'The default assistant did not reach the real model request')
      await capture(control, 'collaboration-first-use-07-result.png')

      await control.command('click', scoped('[data-testid="ai-chat-modal-close"]'))
      await control.command('waitFor', scoped('[data-testid="ai-chat-modal"]'), {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid="cloud-todo-toggle-tasks"]'), {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getValue', scoped('[data-testid="cloud-todo-detail-title"]')),
        ISSUE_NAME,
        'The completed default-assistant run returned to a different Issue'
      )
      assert.ok(
        (
          await control.command('getText', scoped('[data-testid="cloud-todo-state-summary"]'))
        ).includes('1'),
        'The completed default-assistant run was not linked back to the Issue'
      )
      await control.command('click', scoped('[data-testid^="cloud-task-activity-accept-"]'))
      await waitForValue(
        () => control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
        value => value === 'completed',
        'The accepted Issue did not reach the completed state',
        uiTimeoutMs
      )
      await capture(control, 'collaboration-first-use-08-issue-result.png')

      await control.command('click', sidebarScoped('[data-testid="collaboration-primary-agents"]'))
      await control.command(
        'click',
        scoped(`[data-testid="collaboration-agents-delete-${defaultAgentId}"]`)
      )
      await control.command(
        'waitFor',
        scoped('[data-testid="collaboration-delete-agent-dialog"]'),
        { text: DEFAULT_AGENT_NAME, timeoutMs: uiTimeoutMs }
      )
      await capture(control, 'collaboration-first-use-09-delete-agent-confirmation.png')
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="collaboration-delete-agent-confirm"]'),
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'waitFor',
        scoped(`[data-testid="collaboration-agents-row-${defaultAgentId}"]`),
        { visible: false, timeoutMs: uiTimeoutMs }
      )
      await capture(control, 'collaboration-first-use-10-agent-deleted.png')
    },

    diagnostics() {
      return {
        active,
        defaultAgentId,
        requestVerified: Boolean(verifiedRequest),
      }
    },
  }
}
