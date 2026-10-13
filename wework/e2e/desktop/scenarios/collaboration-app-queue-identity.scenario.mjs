import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { selectCollaborationDomain } from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const TITLE = `App queue identity ${process.pid}`
const RESULT = `APP_QUEUE_IDENTITY_COMPLETE_${process.pid}`
const scoped = selector => `${CONTENT} ${selector}`

export function createDesktopScenario({ modelResponseTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud
  let environment
  let app
  let project
  let issue
  const modelRequests = []
  async function request(path, values) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      ...(values ? { method: 'POST', body: JSON.stringify(values) } : {}),
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
    })
    const body = await response.json()
    assert.equal(response.ok, true, `${path}: ${JSON.stringify(body)}`)
    return body
  }
  return {
    requiresCloudEnvironment: true,
    async prepareCloud(value) {
      cloud = value
      await request('/api/admin/setup-complete', {})
    },
    setCloudEnvironment(value) {
      environment = value
    },
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      const kind = codexRequestKind(body)
      if (!['prewarm', 'compaction'].includes(kind) && JSON.stringify(body).includes(RESULT))
        modelRequests.push(body)
      const id = `app-queue-identity-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        createSse([responseCreated(id), assistantMessage(RESULT), responseCompleted(id)])
      )
      return true
    },
    async verify(control) {
      app = await environment.startDuplicateAppDeviceIdentity()
      const workspace = await request('/api/v1/workspaces', { name: TITLE })
      project = await request('/api/v1/cloud-projects', {
        name: TITLE,
        workspace_id: workspace.id,
      })
      for (const path of [
        `/api/v1/workspaces/${workspace.id}/execution-environments`,
        `/api/v1/cloud-projects/${project.id}/execution-environments`,
      ])
        await request(path, { device_id: app.id })
      const catalog = await request(
        `/api/v1/resources/execution-environments?project_id=${project.id}`
      )
      const runner = catalog.find(candidate => candidate.id === String(app.id))
      assert.ok(runner, 'The registered App record is absent from the real runner catalog')
      const model = runner.models.find(candidate => candidate.runtime === 'codex')
      assert.ok(model, 'The registered App did not report its native Codex models')
      const agent = await request(`/api/v1/cloud-projects/${project.id}/chat-agents`, {
        name: TITLE,
        runtime: 'codex',
        systemPrompt: `Return ${RESULT} after completing the assigned task.`,
        executionMode: 'auto',
        executionPolicy: { mode: 'fixed', environment_id: String(app.id) },
        modelPolicy: {
          mode: 'fixed',
          model: { runtime: model.runtime, provider: model.provider, model_id: model.model_id },
        },
        workspaceBinding: { type: 'standalone' },
        workspacePolicy: 'project',
        plugins: [],
      })
      issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, { title: TITLE })
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      await control.command(
        'click',
        scoped(
          `[data-testid="collaboration-workspace-tree-${workspace.id}"] .collaboration-workspace-identity`
        )
      )
      await control.command(
        'click',
        scoped(`[data-testid="collaboration-workspace-project-${project.id}"]`)
      )
      await control.command(
        'clickWhenEnabled',
        scoped(`[data-testid="cloud-todo-card-${issue.id}"]`)
      )
      await control.command('click', scoped('[data-testid="cloud-todo-detail-assignee"]'))
      await control.command(
        'click',
        `[data-testid="cloud-todo-detail-assignee-option-agent:${agent.id}"]`
      )
      await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'))
      await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
        text: RESULT,
        timeoutMs: modelResponseTimeoutMs,
      })
      const deadline = Date.now() + workbenchReadyTimeoutMs
      let executions
      do {
        executions = await request(
          `/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`
        )
        if (executions.items.length === 1 && executions.items[0].status === 'completed') break
        await new Promise(resolve => setTimeout(resolve, 200))
      } while (Date.now() < deadline)
      assert.equal(executions.items.length, 1, 'One assignment created multiple executions')
      assert.equal(executions.items[0].status, 'completed', JSON.stringify(executions.items))
      assert.equal(executions.items[0].runtimeDeviceId, app.execution_target_id)
      assert.equal(modelRequests.length, 1, 'The duplicate App also executed the assigned Issue')
    },
    diagnostics() {
      return {
        appRecord: app?.id,
        projectId: project?.id,
        issueId: issue?.id,
        modelRequests: modelRequests.length,
      }
    },
  }
}
