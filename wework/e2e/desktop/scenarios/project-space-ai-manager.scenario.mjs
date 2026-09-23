import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
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

export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs }) {
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
      response.end(createSse([responseCreated(id), assistantMessage('项目 AI 已检查 Issue 看板。'), responseCompleted(id)]))
      return true
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, ROOT, PROJECT_NAME)
      await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
      await control.command('click', scoped('[data-testid="collaboration-project-settings-project-ai"]'))
      await control.command('waitFor', scoped('[data-testid="project-ai-settings"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid="project-ai-enabled"]'), {
        timeoutMs: uiTimeoutMs,
      })
      const defaultEnabled = await control.command('getAttribute', scoped('[data-testid="project-ai-enabled"]'), { value: 'checked' })
      assert.equal(defaultEnabled, '', 'Project AI must start disabled')
      const agentId = await control.command('getAttribute', scoped('[data-testid="project-ai-agent"] option:nth-child(2)'), { value: 'value' })
      assert.ok(agentId, 'Local project must expose a selectable Agent')
      await control.command('select', scoped('[data-testid="project-ai-agent"]'), { value: agentId })
      await control.command('fill', scoped('[data-testid="project-ai-instructions"]'), { value: `${MARKER}: coordinate the board` })
      await control.command('click', scoped('[data-testid="project-ai-enabled"]'))
      await control.command('click', scoped('[data-testid="project-ai-add-trigger"]'))
      await control.command('clickWhenEnabled', scoped('[data-testid="project-ai-save"]'), { timeoutMs: uiTimeoutMs })
      await control.command('click', scoped('[data-testid="collaboration-project-settings-project"]'))
      await control.command('click', scoped('[data-testid="collaboration-project-settings-project-ai"]'))
      await control.command('waitFor', scoped('[data-testid="project-ai-instructions"]'), { timeoutMs: uiTimeoutMs })
      assert.equal(await control.command('getValue', scoped('[data-testid="project-ai-instructions"]')), `${MARKER}: coordinate the board`)
      await control.command('fill', scoped('[data-testid="project-ai-message"]'), { value: 'Summarize the project board' })
      await control.command('clickWhenEnabled', scoped('[data-testid="project-ai-send"]'), { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', scoped('[data-testid^="project-ai-run-local-manager-run-"]'), { timeoutMs: uiTimeoutMs })
      const deadline = Date.now() + workbenchReadyTimeoutMs
      while (!modelCalled && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert.equal(modelCalled, true, 'Project AI did not reach the configured model')
      const runSelector = scoped('[data-testid^="project-ai-run-local-manager-run-"]')
      let runStatus = ''
      const completionDeadline = Date.now() + workbenchReadyTimeoutMs
      while (Date.now() < completionDeadline) {
        runStatus = await control.command('getText', runSelector)
        if (runStatus.includes('succeeded') || runStatus.includes('failed')) break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      assert.ok(runStatus.includes('succeeded'), `Project AI run did not succeed: ${runStatus}`)
    },
  }
}
