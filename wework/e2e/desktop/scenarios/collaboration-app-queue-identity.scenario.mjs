import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { readProjectChatMessages } from '../modules/project-chat-snapshot.mjs'
import {
  reloadMainWindow,
  selectCollaborationDomain,
  selectCollaborationIssueAgent,
} from '../modules/workspace-flows.mjs'
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
const REPLY = `APP_QUEUE_IDENTITY_REPLY_${process.pid}`
const PROGRESS = `${REPLY}_RUNNING`
const REPLY_RESULT = `${REPLY}_COMPLETE`
const scoped = selector => `${CONTENT} ${selector}`

async function waitForValue(load, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest
  do {
    latest = await load()
    const result = predicate(latest)
    if (result) return result === true ? latest : result
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

export function createDesktopScenario({ modelResponseTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud
  let environment
  let app
  let project
  let issue
  const modelRequests = []
  let releaseReply
  const replyReleased = new Promise(resolve => {
    releaseReply = resolve
  })
  async function request(path, values) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      ...(values ? { method: 'POST', body: JSON.stringify(values) } : {}),
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    const body = await response.json()
    assert.equal(response.ok, true, `${path}: ${JSON.stringify(body)}`)
    return body
  }

  const messages = () =>
    readProjectChatMessages({ ...cloud, projectId: project.id }, issue.id, 10_000)
  const bindings = () => request(`/api/v1/loop-items/${issue.id}/tasks`)
  const bindingAddresses = items => items.map(({ device_id, task_id }) => [device_id, task_id])

  async function completedResponse(text) {
    return waitForValue(
      messages,
      items => items.find(message => message.status === 'completed' && message.content === text),
      `The real agent response was not persisted: ${text}`,
      modelResponseTimeoutMs
    )
  }

  async function singlePreview(control, testId, text) {
    const card = scoped(`[data-testid="cloud-todo-card-drop-${issue.id}"]`)
    const preview = `${card} [data-testid="cloud-todo-card-${testId}-${issue.id}"]`
    await control.command('waitFor', preview, { text })
    await control.command('scrollIntoView', preview)
    await control.command('waitFor', preview, { text, visible: true, stableMs: 500 })
    for (const selector of [
      `${card} [data-testid^="cloud-todo-card-task-summary-${issue.id}-"]`,
      preview,
    ]) {
      assert.equal(
        Number(await control.command('getElementCount', selector, { visible: true })),
        1,
        `Replying must render exactly one execution preview: ${selector}`
      )
    }
    assert.equal((await control.command('getText', preview)).trim(), text)
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
      const isAssignment =
        !['prewarm', 'compaction'].includes(kind) && JSON.stringify(body).includes(RESULT)
      if (isAssignment) modelRequests.push(body)
      const isReply = isAssignment && JSON.stringify(body).includes(REPLY)
      const id = `app-queue-identity-${Date.now()}`
      const final = assistantMessage(isReply ? REPLY_RESULT : RESULT)
      const progress = assistantMessage(PROGRESS)
      progress.item.phase = 'commentary'
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      response.flushHeaders()
      response.write(createSse([responseCreated(id), ...(isReply ? [progress] : [])]))
      if (isReply) await replyReleased
      if (!response.destroyed && !response.writableEnded) {
        response.write(createSse([final]))
        response.end(
          createSse([responseCompleted(id, [...(isReply ? [progress.item] : []), final.item])])
        )
      }
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
        'waitFor',
        scoped(
          `[data-testid="collaboration-workspace-tree-${workspace.id}"] .collaboration-workspace-identity`
        ),
        { visible: true, timeoutMs: workbenchReadyTimeoutMs }
      )
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
      await selectCollaborationIssueAgent(
        control,
        scoped('[data-testid="cloud-todo-detail-assignee"]'),
        agent.id
      )
      await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'))
      await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
        text: RESULT,
        timeoutMs: modelResponseTimeoutMs,
      })
      const executions = await waitForValue(
        () => request(`/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`),
        value => value.items.length > 0 && value.items.every(item => item.status === 'completed'),
        'The assigned execution did not complete',
        modelResponseTimeoutMs
      )
      assert.equal(executions.items.length, 1, 'One assignment created multiple executions')
      assert.equal(executions.items[0].status, 'completed', JSON.stringify(executions.items))
      assert.equal(executions.items[0].runtimeDeviceId, app.execution_target_id)
      assert.equal(modelRequests.length, 1, 'The duplicate App also executed the assigned Issue')

      const originalResponse = await completedResponse(RESULT)
      const originalBindings = await bindings()
      assert.equal(originalBindings.length, 1, 'One assignment must persist one session binding')
      assert.equal(originalResponse.runtimeAddress.taskId, originalBindings[0].task_id)
      await control.command(
        'waitFor',
        scoped(`[data-testid="cloud-task-activity-execution-badge-${originalResponse.messageId}"]`),
        { text: '已完成' }
      )
      try {
        await control.command(
          'click',
          scoped(`[data-testid="cloud-task-activity-reply-toggle-${originalResponse.messageId}"]`)
        )
        const composer = scoped('[data-testid="issue-reply-composer"]')
        await control.command('fill', `${composer} [data-testid="cloud-task-activity-composer"]`, {
          value: REPLY,
        })
        await control.command('clickWhenEnabled', `${composer} [data-testid="send-message-button"]`)
        await waitForValue(
          () => modelRequests.length,
          count => count >= 2,
          'The real executor did not start the UI reply',
          modelResponseTimeoutMs
        )
        await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
        await singlePreview(control, 'process', PROGRESS)
        assert.deepEqual(bindingAddresses(await bindings()), bindingAddresses(originalBindings))
        assert.equal(modelRequests.length, 2, 'A reply must run once on the assigned App')
      } finally {
        releaseReply()
      }

      const replyResponse = await completedResponse(REPLY_RESULT)
      assert.deepEqual(replyResponse.runtimeAddress, originalResponse.runtimeAddress)
      assert.equal(
        replyResponse.rootMessageId,
        originalResponse.rootMessageId || originalResponse.messageId
      )
      assert.deepEqual(bindingAddresses(await bindings()), bindingAddresses(originalBindings))
      await waitForValue(
        () => request(`/api/v1/loop-items/${issue.id}`),
        item => item.status === 'in_review' && item.execution_state === 'succeeded',
        'The completed reply did not synchronize the Issue back to review',
        modelResponseTimeoutMs
      )
      await singlePreview(control, 'final-response', REPLY_RESULT)
      await reloadMainWindow(control, 'The workbench did not reconnect after the reply')
      await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-board"]')
      await singlePreview(control, 'final-response', REPLY_RESULT)
      assert.deepEqual(bindingAddresses(await bindings()), bindingAddresses(originalBindings))
      assert.equal(modelRequests.length, 2, 'Reloading must not execute the reply again')
      console.info(
        '[app-queue-identity] Verified one execution preview during the UI reply, after completion, and after reload'
      )
    },
    cleanup() {
      releaseReply()
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
