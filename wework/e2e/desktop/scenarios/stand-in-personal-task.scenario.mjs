import { openProjectStandIn } from '../modules/stand-in-flows.mjs'
import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  expandCollaborationWorkspace,
  selectCollaborationDomain,
} from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { selectE2EModel } from '../modules/shared.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const COMPLETE = 'PERSONAL_STAND_IN_COMPLETE'
const COLLABORATION = 'ISSUE_COLLABORATION_WITHOUT_EXTRA_CONFIRMATION'
const scoped = id => `${CONTENT} [data-testid="${id}"]`

export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs }) {
  let cloud
  let environment
  let ownerToken
  let user
  let workspace
  let project
  let manualIssue
  let currentDevice
  const completed = []
  let savedSettings
  let assignmentDiagnostics
  let returnToUser
  const collaborationRuns = new Map()
  const completedCollaborationIssues = []

  function collaborationEvents(body, issue) {
    const input = JSON.stringify(body.input ?? [])
    assert.doesNotMatch(
      input,
      /private AI task|Only change shared Issue|immutable execution context/
    )
    const run = collaborationRuns.get(issue.id) ?? { step: 0 }
    collaborationRuns.set(issue.id, run)
    const steps = [
      { name: 'get_current_context', args: {} },
      {
        name: 'get_board_item',
        args: { space_id: String(project.id), item_id: issue.id },
      },
      {
        name: 'get_board_item',
        args: { space_id: String(project.id), item_id: issue.id },
      },
      {
        name: 'add_board_item_comment',
        args: { space_id: String(project.id), item_id: issue.id, body: COLLABORATION },
      },
      {
        name: 'assign_board_item',
        args: {
          space_id: String(project.id),
          item_id: issue.id,
          assignee_type: 'user',
          assignee_id: String(returnToUser.id),
        },
      },
    ]
    const callId = () => `issue-collaboration-${issue.id}-${run.step}`
    if (requestContainsToolOutput(body, callId())) {
      const value = JSON.parse(readMcpToolOutput(body, callId()))
      if (run.step === 0) {
        assert.equal(value.space_id, String(project.id))
        assert.equal(value.item_id, issue.id)
      }
      assert.ok(!value.error && !value.isError, JSON.stringify(value))
      run.step++
    }
    if (run.step === steps.length) return [assistantMessage(COMPLETE)]
    const step = steps[run.step]
    return mcpToolRequestEvents(body, {
      toolName: step.name,
      argumentsValue: step.args,
      directToolName: (body.tools ?? [])
        .map(tool => tool.name)
        .find(name => name?.endsWith(`__${step.name}`)),
      searchCallId: `${callId()}-search`,
      toolCallId: callId(),
    }).events
  }

  async function assertCollaboration(issue) {
    assert.equal(
      collaborationRuns.get(issue.id)?.step,
      5,
      'All real collaboration tools must finish'
    )
    const persisted = await request(`/v1/loop-items/${issue.id}`)
    assert.equal(persisted.assignee_user_id, returnToUser.id)
    const comments = await request(
      `/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`
    )
    assert.equal(comments.filter(comment => comment.body === COLLABORATION).length, 1)
  }

  async function request(path, body, token = cloud.authToken, method = body ? 'POST' : 'GET') {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
    const text = await response.text()
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }

  async function assertCompleted(control, issue) {
    const deadline = Date.now() + modelResponseTimeoutMs
    let bindings
    while (Date.now() < deadline) {
      bindings = await request(`/v1/loop-items/${issue.id}/tasks`)
      assert.ok(bindings.length <= 1, 'One Issue must not create duplicate personal tasks')
      if (bindings[0]) {
        assert.equal(bindings[0].device_id, currentDevice)
        const result = await requestExecutor(
          control,
          'runtime.tasks.get',
          {
            taskId: bindings[0].task_id,
          },
          uiTimeoutMs
        )
        assert.notEqual(result.task?.status, 'failed', JSON.stringify(result))
        if (result.task?.status === 'done') {
          if (issue.title.includes(COLLABORATION)) {
            const transcript = await requestExecutor(
              control,
              'runtime.tasks.transcript',
              { taskId: bindings[0].task_id, limit: 100 },
              uiTimeoutMs
            )
            const blocks = [
              ...transcript.messages.flatMap(message => message.blocks ?? []),
              ...(transcript.runtimeTurns ?? []).flatMap(turn =>
                (turn.items ?? []).map(item => item.block)
              ),
            ]
            assert.equal(
              blocks.filter(block => block?.tool_name === 'auto_approval_review').length,
              0,
              'Collaboration reads, comments and assignments must not trigger AI review'
            )
          }
          completed.push(issue.id)
          return bindings[0]
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assignmentDiagnostics = await request(`/v1/loop-items/${issue.id}/assignments`)
    assert.fail(
      `Personal task did not complete: ${JSON.stringify({ bindings, assignments: assignmentDiagnostics, enabledAfter: savedSettings?.enabledAfter })}`
    )
  }

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(value) {
      cloud = value
      await request('/admin/setup-complete', {})
      user = await request('/users/me')
      const userName = `stand-in-project-owner-${process.pid}`
      const password = 'stand-in-personal-task-e2e'
      await request('/admin/users', {
        user_name: userName,
        password,
        role: 'admin',
        auth_source: 'password',
      })
      ownerToken = (await request('/auth/login', { user_name: userName, password })).access_token
      returnToUser = await request('/users/me', undefined, ownerToken)
      workspace = await request(
        '/v1/workspaces',
        { name: `Personal stand-in ${process.pid}` },
        ownerToken
      )
      project = await request(
        `/v1/workspaces/${workspace.id}/projects`,
        {
          name: `No environment setup ${process.pid}`,
        },
        ownerToken
      )
      await request(
        `/v1/workspaces/${workspace.id}/members`,
        { user_id: user.id, role: 'Developer' },
        ownerToken
      )
      manualIssue = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
        title: `${COLLABORATION} manual task`,
      })
    },
    setCloudEnvironment(value) {
      environment = value
    },
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (isReplyPredictionRequest(body)) return false
      const kind = codexRequestKind(body)
      const input = JSON.stringify(body.input ?? [])
      const collaborationIssue = ['prewarm', 'compaction'].includes(kind)
        ? undefined
        : [manualIssue, ...completedCollaborationIssues].find(
            issue => issue && input.includes(issue.title)
          )
      if (collaborationIssue)
        console.log(
          '[e2e] Issue collaboration model request',
          JSON.stringify({ kind, tools: (body.tools ?? []).map(tool => tool.name ?? tool.type) })
        )
      if (collaborationIssue?.id === manualIssue.id) {
        assert.ok(
          input.includes(
            'Collaboration actions within that scope do not require separate user confirmation'
          )
        )
      }
      const events = collaborationIssue
        ? collaborationEvents(body, collaborationIssue)
        : [assistantMessage(COMPLETE)]
      const id = `personal-stand-in-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const desktop = await environment.waitForConnectedAppDevice()
      currentDevice = desktop.app_device_id ?? desktop.device_id
      // A real ordinary member, with no project device binding or initialized environment.
      await request(`/admin/users/${user.id}/role`, { role: 'user' }, ownerToken, 'PUT')
      assert.equal((await request('/users/me')).role, 'user')
      assert.equal((await request(`/v1/cloud-projects/${project.id}`)).access_role, 'Developer')
      assert.deepEqual(
        (await request(`/v1/cloud-projects/${project.id}/execution-environments`)).items,
        []
      )
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      await expandCollaborationWorkspace(
        control,
        scoped(`collaboration-workspace-toggle-${workspace.id}`)
      )
      await control.command('click', scoped(`collaboration-workspace-project-${project.id}`))
      await control.command('clickWhenEnabled', scoped('collaboration-tab-board'))
      await control.command('clickWhenEnabled', scoped(`cloud-todo-card-${manualIssue.id}`))
      await control.command('clickWhenEnabled', scoped('cloud-todo-personal-task-start'))
      const composer = `${scoped('work-item-new-task-chat-panel')} [data-testid="chat-message-input"]`
      await control.command('waitFor', composer)
      await selectE2EModel(control, undefined, undefined, scoped('work-item-new-task-chat-panel'))
      await control.command('press', composer, { key: 'Enter' })
      await control.command(
        'waitFor',
        `${scoped('ai-chat-modal')} [data-testid="message-assistant"]`,
        {
          text: COMPLETE,
          timeoutMs: modelResponseTimeoutMs,
        }
      )
      await assertCompleted(control, manualIssue)
      await assertCollaboration(manualIssue)
      await control.command('click', scoped('ai-chat-modal-close'))
      await control.command('click', scoped('cloud-todo-detail-close'))
      await openProjectStandIn(control, scoped('stand-in-open'), { connect: true })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-auto"]')
      await control.command('fill', '[data-testid="stand-in-prompt"]', {
        value: 'Review my assigned Issues, post the result and return them to the project owner.',
      })
      const catalog = await requestExecutor(control, 'runtime.runner.catalog', {}, uiTimeoutMs)
      const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
      assert.ok(model, 'The stand-in must use the registered E2E Codex model')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-advanced-open"]')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="stand-in-settings"] [data-testid="model-selector-button"]'
      )
      const modelKey = JSON.stringify([model.runtime, model.provider, model.model_id])
      await control.command(
        'clickWhenEnabled',
        `[data-testid=${JSON.stringify(`model-option-${modelKey}`)}]`
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-prompt"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
      const params = { projectId: String(project.id), userId: user.id, projectStore: 'cloud' }
      const settings = await requestExecutor(control, 'runtime.stand_in.get', params, uiTimeoutMs)
      savedSettings = settings
      assert.equal(settings.enabled, true)
      const issue = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
        title: `${COLLABORATION} stand-in task`,
        assignee_user_id: user.id,
      })
      completedCollaborationIssues.push(issue)
      await assertCompleted(control, issue)
      await assertCollaboration(issue)
      assert.deepEqual(
        (await request(`/v1/cloud-projects/${project.id}/execution-environments`)).items,
        []
      )
      const disabled = await requestExecutor(
        control,
        'runtime.stand_in.save',
        {
          ...params,
          settings: { ...settings, enabled: false },
        },
        uiTimeoutMs
      )
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      for (const status of ['in_review', 'completed']) {
        const delegated = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
          title: `Delegate ${status} from the assignment notification`,
          status,
          assignee_user_id: user.id,
        })
        if (status === 'completed') assert.ok(delegated.completed_at)
        await control.command('click', '[data-testid="wework-notifications-refresh"]')
        await control.command(
          'waitFor',
          '[data-testid="wework-notifications-refresh"]:not([disabled])'
        )
        const inbox = await request('/v1/wework-notifications?category=collaboration')
        const notice = inbox.items.find(row => row.payload.itemId === delegated.id)
        assert.ok(notice, 'Assignment notification must exist for every Issue status')
        const start = `[data-testid="notification-stand-in-start-${notice.id}"]`
        await control.command('clickWhenEnabled', start)
        await control.command(
          'waitFor',
          `[data-testid="notification-stand-in-status-${notice.id}"]`,
          {
            text: '处理完毕',
            timeoutMs: modelResponseTimeoutMs,
          }
        )
        const binding = await assertCompleted(control, delegated)
        const repeated = await requestExecutor(
          control,
          'runtime.stand_in.run',
          {
            ...params,
            issueId: delegated.id,
          },
          uiTimeoutMs
        )
        assert.equal(repeated.taskId, binding.task_id)
      }
      const enabled = await requestExecutor(
        control,
        'runtime.stand_in.save',
        {
          ...params,
          settings: { ...disabled, enabled: true },
        },
        uiTimeoutMs
      )
      for (const status of ['in_review', 'completed']) {
        const automatic = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
          title: `Automatically handle ${status} assignment`,
          status,
          assignee_user_id: user.id,
        })
        await control.command('click', '[data-testid="wework-notifications-refresh"]')
        await control.command(
          'waitFor',
          '[data-testid="wework-notifications-refresh"]:not([disabled])'
        )
        await assertCompleted(control, automatic)
      }
      await requestExecutor(
        control,
        'runtime.stand_in.save',
        {
          ...params,
          settings: { ...enabled, enabled: false },
        },
        uiTimeoutMs
      )
    },
    diagnostics() {
      return { projectId: project?.id, completed, savedSettings, assignmentDiagnostics }
    },
  }
}
