import assert from 'node:assert/strict'

import { declineInitialTelemetryConsent, ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { createLocalCollaborationProject } from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const ROOT = '[data-workspace-tab-content][aria-hidden="false"]'
const MARKER = 'PROJECT_SPACE_AI_MANAGER_E2E'
const PROJECT_NAME = `项目 AI 管理者验收-${process.pid}`

function scoped(selector) {
  return `${ROOT} ${selector}`
}

export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs, captureScreenshot }) {
  let modelCalled = false
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readRequestBody(request)
      if (!JSON.stringify(body).includes(MARKER)) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'Unexpected model request in project AI scenario' }))
        return true
      }
      modelCalled = true
      const id = `project-space-manager-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage('项目 AI 已检查 Issue #1 看板。'),
          responseCompleted(id),
        ])
      )
      return true
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, ROOT, PROJECT_NAME)
      await control.command('waitFor', scoped('[data-testid="project-ai-expand"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', scoped('[data-testid="collaboration-empty-project-create"]'))
      await control.command('waitFor', scoped('[data-testid="cloud-todo-title"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
        value: '项目 AI 导航验收 Issue',
      })
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="cloud-todo-create-confirm"]'),
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
      await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
      await control.command(
        'click',
        scoped('[data-testid="collaboration-project-settings-participants"]')
      )
      await control.command(
        'click',
        scoped('[data-testid="collaboration-participants-tab-manager"]')
      )
      await control.command('waitFor', scoped('[data-testid="project-ai-settings"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid="project-ai-enabled"]'), {
        timeoutMs: uiTimeoutMs,
      })
      const defaultEnabled = await control.command(
        'getAttribute',
        scoped('[data-testid="project-ai-enabled"]'),
        { value: 'data-enabled' }
      )
      assert.equal(
        defaultEnabled,
        'true',
        'Project AI must start enabled when the default Agent is available'
      )
      const agentId = await control.command(
        'getAttribute',
        scoped('[data-testid="project-ai-agent"] option:nth-child(2)'),
        { value: 'value' }
      )
      assert.ok(agentId, 'Local project must expose a selectable Agent')
      assert.equal(
        await control.command('getValue', scoped('[data-testid="project-ai-agent"]')),
        agentId
      )
      await control.command('fill', scoped('[data-testid="project-ai-instructions"]'), {
        value: `${MARKER}: coordinate the board`,
      })
      await control.command('clickWhenEnabled', scoped('[data-testid="project-ai-save"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'click',
        scoped('[data-testid="collaboration-project-settings-automatic-processing"]')
      )
      await control.command('waitFor', scoped('[data-testid="automatic-processing"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', scoped('[data-testid="project-ai-add-trigger"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid="project-ai-trigger-form"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clickWhenEnabled', scoped('[data-testid="project-ai-save"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid^="project-ai-trigger-"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'click',
        scoped('[data-testid="collaboration-project-settings-participants"]')
      )
      await control.command(
        'click',
        scoped('[data-testid="collaboration-participants-tab-manager"]')
      )
      await control.command('waitFor', scoped('[data-testid="project-ai-instructions"]'), {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getValue', scoped('[data-testid="project-ai-instructions"]')),
        `${MARKER}: coordinate the board`
      )
      await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
      await control.command('waitFor', scoped('[data-testid="project-ai-expand"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('hover', scoped('[data-testid="project-ai-expand"]'))
      await control.command('waitFor', scoped('[data-testid="project-ai-conversation"]'), {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(await control.command('getAttribute', scoped('[data-testid="project-ai-board-assistant"]'), { value: 'data-pinned' }), 'false', 'Hover alone must not pin the composer')
      await control.command('click', scoped('[data-testid="collaboration-board"]'))
      await control.command('waitFor', scoped('[data-testid="project-ai-expand"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', scoped('[data-testid="project-ai-expand"]'))
      await control.command(
        'waitFor',
        scoped('[data-testid="project-ai-composer"] [data-testid="project-chat-composer-form"]'),
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'waitFor',
        scoped('[data-testid="project-ai-composer"] [data-testid="model-selector-button"]'),
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'click',
        scoped('[data-testid="project-ai-composer"] [data-testid="model-selector-button"]')
      )
      await control.command('click', scoped('[data-testid="collaboration-board"]'))
      await new Promise(resolve => setTimeout(resolve, 1700))
      await control.command('waitFor', scoped('[data-testid="project-ai-conversation"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', scoped('[data-testid="project-ai-message"]'), {
        value: 'Keep this draft',
      })
      await control.command('click', scoped('[data-testid="collaboration-board"]'))
      await control.command('waitFor', scoped('[data-testid="project-ai-conversation"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', scoped('[data-testid="project-ai-close-conversation"]'))
      await control.command('waitFor', scoped('[data-testid="project-ai-expand"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', scoped('[data-testid="project-ai-expand"]'))
      assert.equal(
        await control.command('getValue', scoped('[data-testid="project-ai-message"]')),
        'Keep this draft'
      )
      await control.command('fill', scoped('[data-testid="project-ai-message"]'), {
        value: 'Summarize the project board',
      })
      await control.command('clickWhenEnabled', scoped('[data-testid="project-ai-send"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid="project-ai-conversation-history"]'), {
        text: 'Summarize the project board',
        timeoutMs: uiTimeoutMs,
      })
      const deadline = Date.now() + workbenchReadyTimeoutMs
      while (!modelCalled && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert.equal(modelCalled, true, 'Project AI did not reach the configured model')
      await control.command('waitFor', scoped('[data-testid="project-ai-conversation-history"]'), {
        text: '项目 AI 已检查 Issue #1 看板。',
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await declineInitialTelemetryConsent(control)
      await captureScreenshot(control, 'project-ai-conversation.png')
      await control.command('click', scoped('[data-testid^="project-ai-response-issue-"]'))
      await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
        text: '项目 AI 导航验收 Issue',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
      await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
      await control.command(
        'waitFor',
        scoped('[data-testid="project-ai-open-current-task"]:not(:disabled)'),
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('click', scoped('[data-testid="project-ai-open-current-task"]'))
      await control.command(
        'waitFor',
        '[data-testid="workspace-tab-content-fixed-board"][aria-hidden="true"]',
        { timeoutMs: uiTimeoutMs }
      )
    },
  }
}
