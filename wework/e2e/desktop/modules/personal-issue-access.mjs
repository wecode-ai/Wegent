import assert from 'node:assert/strict'

import {
  assistantMessage,
  codexRequestKind,
  createSse,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, selectE2EModel } from './shared.mjs'

const MARKER = 'PERSONAL_ISSUE_ACCESS_E2E'
const COMPLETE = `${MARKER}_COMPLETE`
const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PANEL = `${CONTENT} [data-testid="work-item-new-task-chat-panel"]`

const stableIssue = issue => ({
  id: issue.id,
  title: issue.title,
  version: issue.version,
  description: issue.description,
  status: issue.status,
  assignee_user_id: issue.assignee_user_id,
  assignee_agent_id: issue.assignee_agent_id,
})

async function waitForValue(load, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await load()
    const match = predicate(latest)
    if (match) return match === true ? latest : match
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

// Only model responses are synthetic; all tools, identities and records are real.
export function createPersonalIssueAccessRegression({ uiTimeoutMs, modelResponseTimeoutMs }) {
  let cloud
  let sourceProject
  let sourceIssue
  let originalBinding
  let sourceBefore
  let deliveryId
  let creatorToken
  let active = false
  let toolRunVerified = false
  const targets = []
  const steps = []
  let stepIndex = 0

  async function request(path, values, token = cloud.authToken, method = values ? 'POST' : 'GET') {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(values ? { body: JSON.stringify(values) } : {}),
    })
    const text = await response.text()
    assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}: ${text}`)
    // Preserve exact 64-bit binding IDs instead of rounding them in JavaScript.
    return text
      ? JSON.parse(text, (_key, value, context) =>
          typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
            ? context.source
            : value
        )
      : null
  }

  function addSteps() {
    const assertContext = value => {
      assert.equal(value.space_id, String(sourceProject.id))
      assert.equal(value.item_id, sourceIssue.id)
    }
    steps.push({ name: 'get_current_context', args: () => ({}), verify: assertContext })
    steps.push({
      name: 'create_delivery',
      args: () => ({ markdown: MARKER }),
      verify: value => {
        assert.ok(value.id, 'The real personal task did not create a delivery')
        assert.equal(value.loop_item_id, sourceIssue.id)
        assert.equal(value.status, 'draft')
        deliveryId = value.id
      },
    })
    for (const target of targets) {
      const args = { space_id: String(target.project.id), item_id: target.issue.id }
      steps.push({
        name: 'get_board_item',
        args: () => args,
        denied: target.permission === 'none',
        deniedStatus: 404,
        verify: value => {
          assert.equal(value.id, target.issue.id)
          target.read = value
        },
      })
      steps.push({
        name: 'update_board_item',
        args: () => ({
          ...args,
          item: {
            version: target.read?.version ?? target.issue.version,
            title: MARKER + target.issue.id,
          },
        }),
        denied: target.permission !== 'write',
        deniedStatus: target.permission === 'none' ? 404 : 403,
      })
      steps.push({
        name: 'add_board_item_comment',
        args: () => ({ ...args, body: MARKER }),
        denied: target.permission !== 'write',
        deniedStatus: target.permission === 'none' ? 404 : 403,
      })
    }
    steps.push({ name: 'get_current_context', args: () => ({}), verify: assertContext })
  }

  async function nextToolEvents(body) {
    let step = steps[stepIndex]
    const callId = () => `personal-access-${stepIndex}`
    if (step && requestContainsToolOutput(body, callId())) {
      const result = readMcpToolOutput(body, callId())
      if (step.denied)
        assert.match(
          result,
          step.deniedStatus === 404
            ? /^Backend request failed \(404 Not Found\): \{"detail":"Cloud project not found"\}$/
            : /^Backend request failed \(403 Forbidden\): \{"detail":"Insufficient permission"\}$/,
          `${step.name} did not reject the unauthorized operation`
        )
      else {
        const value = JSON.parse(result)
        step.verify?.(value)
      }
      console.log(
        `[e2e] Personal Issue MCP ${step.name}: ${step.denied ? 'permission denied' : 'succeeded'}`
      )
      stepIndex += 1
      step = steps[stepIndex]
    }
    if (!step) {
      await assertPersistedResults()
      toolRunVerified = true
      return [assistantMessage(COMPLETE)]
    }
    return mcpToolRequestEvents(body, {
      toolName: step.name,
      argumentsValue: step.args(),
      directToolName: (body.tools ?? [])
        .map(tool => tool.name)
        .find(name => name?.endsWith(`__${step.name}`)),
      searchCallId: `${callId()}-search`,
      toolCallId: callId(),
    }).events
  }

  async function assertPersistedResults() {
    assert.deepEqual(
      (await request(`/api/v1/loop-items/${sourceIssue.id}/tasks`)).map(binding => ({
        id: binding.id,
        task_id: binding.task_id,
        device_id: binding.device_id,
        loop_item_id: binding.loop_item_id,
        cloud_project_id: binding.cloud_project_id,
      })),
      [originalBinding],
      'Cross Issue access changed the original session binding'
    )
    assert.deepEqual(
      stableIssue(await request(`/api/v1/loop-items/${sourceIssue.id}`)),
      sourceBefore,
      'Personal task operations changed their source Issue'
    )
    const delivery = await request(`/api/v1/deliveries/${deliveryId}`)
    assert.ok(delivery, 'The source Issue did not retain the personal task delivery')
    assert.equal(delivery.id, deliveryId)
    assert.equal(delivery.status, 'draft')
    assert.equal(delivery.markdown, MARKER)
    assert.equal(delivery.loop_item_id, sourceIssue.id)
    assert.equal(String(delivery.source_task_binding_id), String(originalBinding.id))
    assert.equal(delivery.source_task_snapshot.taskId, originalBinding.task_id)
    assert.equal(delivery.source_task_snapshot.deviceId, originalBinding.device_id)
    for (const target of targets) {
      const token = target.token ?? cloud.authToken
      const persisted = await request(`/api/v1/loop-items/${target.issue.id}`, undefined, token)
      const comments = await request(
        `/api/v1/cloud-projects/${target.project.id}/loop-items/${target.issue.id}/activity-comments`,
        undefined,
        token
      )
      if (target.permission === 'write') {
        assert.equal(persisted.title, MARKER + target.issue.id)
        assert.equal(comments.filter(comment => comment.body === MARKER).length, 1)
      } else {
        assert.deepEqual(
          stableIssue(persisted),
          stableIssue(target.issue),
          'A denied operation changed the target Issue'
        )
        assert.equal(
          comments.some(comment => comment.body === MARKER),
          false
        )
      }
      assert.deepEqual(
        await request(`/api/v1/loop-items/${target.issue.id}/tasks`, undefined, token),
        [],
        'Cross Issue access rebound the personal task to its target'
      )
      assert.deepEqual(
        (await request(`/api/v1/loop-items/${target.issue.id}/deliveries`, undefined, token)).items,
        [],
        'The source delivery leaked into a target Issue'
      )
    }
  }

  return {
    async prepare(value, project, issue) {
      cloud = value
      sourceProject = project
      sourceIssue = issue
      const owner = await request('/api/users/me')
      const username = `issue-access-owner-${process.pid}`
      const password = 'isolated-issue-access-e2e'
      await request('/api/admin/users', {
        user_name: username,
        password,
        role: 'user',
        auth_source: 'password',
      })
      creatorToken = (await request('/api/auth/login', { user_name: username, password }))
        .access_token
      const workspace = await request(
        '/api/v1/workspaces',
        { name: `Issue access ${process.pid}` },
        creatorToken
      )
      const sameIssue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        title: 'Same project target',
      })
      targets.push({ project, issue: sameIssue, permission: 'write' })
      for (const permission of ['write', 'read', 'none']) {
        const targetProject = await request(
          `/api/v1/workspaces/${workspace.id}/projects`,
          {
            name: `Issue access ${permission}`,
            visibility: 'private',
          },
          creatorToken
        )
        const targetIssue = await request(
          `/api/v1/cloud-projects/${targetProject.id}/loop-items`,
          {
            title: `Cross project ${permission}`,
          },
          creatorToken
        )
        if (permission !== 'none')
          await request(
            `/api/v1/cloud-projects/${targetProject.id}/members`,
            {
              user_id: owner.id,
              role: permission === 'write' ? 'Developer' : 'Viewer',
            },
            creatorToken
          )
        targets.push({
          project: targetProject,
          issue: targetIssue,
          permission,
          token: creatorToken,
        })
      }
      addSteps()
    },

    async handleHttp(message, response, url) {
      if (
        !active ||
        message.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(message)
      const id = `personal-issue-access-${Date.now()}`
      let events = []
      const kind = codexRequestKind(body)
      if (!['prewarm', 'compaction'].includes(kind) && JSON.stringify(body).includes(MARKER)) {
        await waitForValue(
          () => originalBinding,
          Boolean,
          'The personal task binding was not recorded before tool execution',
          uiTimeoutMs
        )
        events = await nextToolEvents(body)
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },

    async verify(control) {
      active = true
      const me = await request('/api/users/me')
      const assigned = await request(`/api/v1/loop-items/${sourceIssue.id}/assignments`, {
        target_type: 'human',
        target_id: String(me.id),
        notify_target: false,
      })
      const started = await request(
        `/api/v1/loop-items/${sourceIssue.id}`,
        { version: assigned.issue.version, status: 'in_progress' },
        cloud.authToken,
        'PATCH'
      )
      assert.equal(started.status, 'in_progress')
      assert.equal(started.human_task_binding.assignmentId, assigned.assignment.id)
      sourceBefore = stableIssue(await request(`/api/v1/loop-items/${sourceIssue.id}`))
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/${sourceProject.id}/issues/${sourceIssue.id}`,
      })
      await control.command(
        'waitFor',
        `${CONTENT} [data-testid="cloud-todo-personal-task-start"]`,
        {
          visible: true,
        }
      )
      await control.command(
        'clickWhenEnabled',
        `${CONTENT} [data-testid="cloud-todo-personal-task-start"]`
      )
      const composer = `${PANEL} [data-testid="chat-message-input"]`
      await control.command('waitFor', composer, { visible: true })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, PANEL)
      await control.command('fill', composer, { value: MARKER })
      await control.command('press', composer, { key: 'Enter' })
      const binding = await waitForValue(
        () => request(`/api/v1/loop-items/${sourceIssue.id}/tasks`),
        values => values.length === 1 && values[0],
        'The personal Runtime task was not bound',
        uiTimeoutMs
      )
      originalBinding = {
        id: binding.id,
        task_id: binding.task_id,
        device_id: binding.device_id,
        loop_item_id: binding.loop_item_id,
        cloud_project_id: binding.cloud_project_id,
      }
      await control.command(
        'waitFor',
        `${CONTENT} [data-testid="ai-chat-modal"] [data-testid="message-assistant"]`,
        {
          text: COMPLETE,
          timeoutMs: modelResponseTimeoutMs,
        }
      )
      assert.equal(toolRunVerified, true, 'The model completed without exercising real MCP tools')
      await assertPersistedResults()
      await control.command('click', `${CONTENT} [data-testid="ai-chat-modal-close"]`)
      console.log('[e2e] Personal task same/cross project permissions and source bindings verified')
      active = false
    },
  }
}
