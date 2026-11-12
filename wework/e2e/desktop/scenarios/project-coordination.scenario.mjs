import assert from 'node:assert/strict'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  createLocalCollaborationProject,
  configureFirstProjectExecutionEnvironment,
  enterProjectCollaborationView,
  reloadMainWindow,
} from '../modules/workspace-flows.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  requestContainsToolOutput,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { selectCollaborationProjectView } from '../modules/collaboration-project-navigation.mjs'

const USER = 9001
const LOCAL_OWNER = 0
const PROJECT = `项目自动统筹-${process.pid}`
const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PRIVATE = 'PRIVATE_COORDINATION_MEMORY_MUST_NOT_ENTER_SHARED_ASSESSMENT'
const CONFIRMED = '验收标准已确认：完成权限隔离验证'
const WORK_MARKER = 'PROJECT_COORDINATION_APPROVED_NATIVE_WORK'
const WORK_RESULT = '项目原队列中的负责人已完成权限隔离验证，请确认结果。'
const OUTCOME_CALL = 'project-coordination-original-work-outcome'

function strings(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

/** Uses the real DSH plugin, Native queue and SQLite; mocks only model HTTP. */
export function createDesktopScenario({
  captureScreenshot,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  restartDesktopApp,
  resultDir,
}) {
  let assessments = 0
  let expectedModel
  let workRequests = 0
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  async function until(load, ready, label) {
    const deadline = Date.now() + uiTimeoutMs + modelResponseTimeoutMs
    let value
    while (Date.now() < deadline) {
      try {
        value = await load()
      } catch (error) {
        console.error('[project-coordination-observation-error]', {
          message: error.message,
          cause: error.cause?.message,
          code: error.cause?.code,
          nestedCause: error.cause?.cause?.message,
          nestedCode: error.cause?.cause?.code,
        })
        throw error
      }
      if (ready(value)) return value
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail(`${label}: ${JSON.stringify(value)}`)
  }
  return {
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (isReplyPredictionRequest(body)) return false
      const prompt = strings(body.input).find(text =>
        text.includes('Assess only the supplied shared project events')
      )
      if (!prompt && JSON.stringify(body).includes(WORK_MARKER)) {
        assert.ok(!JSON.stringify(body).includes(PRIVATE))
        assert.equal(body.model, expectedModel)
        assert.ok(req.headers.authorization)
        const id = `project-original-work-${++workRequests}`
        const events = requestContainsToolOutput(body, OUTCOME_CALL)
          ? [assistantMessage(WORK_RESULT)]
          : mcpToolRequestEvents(body, {
              toolName: 'update_issue_status',
              argumentsValue: {
                status: 'in_review',
                reason: WORK_RESULT,
                comment: WORK_RESULT,
              },
              searchCallId: `${OUTCOME_CALL}-search`,
              toolCallId: OUTCOME_CALL,
            }).events
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
        return true
      }
      if (!prompt) return false
      assert.equal(body.model, expectedModel, 'Assessment keeps the selected Native model')
      assert.ok(req.headers.authorization, 'The original Native provider authenticates the request')
      assert.ok(
        !JSON.stringify(body).includes(PRIVATE),
        'Private memory cannot enter shared assessment'
      )
      const tools = [
        ...(body.tools ?? []),
        ...(body.input ?? [])
          .filter(item => item.type === 'additional_tools')
          .flatMap(item => item.tools ?? []),
      ]
      assert.deepEqual(
        tools,
        [],
        `Assessment has no execution or private search tools, including incremental definitions; kind=${codexRequestKind(body)}`
      )
      const input = JSON.parse(prompt.slice(prompt.lastIndexOf('\n{') + 1))
      assert.ok(input.events.length > 0)
      const confirmed = input.events.some(event => event.comment?.body === CONFIRMED)
      const decisions = [
        {
          kind: confirmed ? 'dispatch_issue' : 'ask',
          eventIds: input.events.map(event => event.id),
          issueId: input.events[0].issueId,
          reason: confirmed ? '执行已明确的权限隔离验证' : '请在原 Issue 中补充验收标准。',
          at: null,
        },
      ]
      assessments++
      const id = `project-coordination-${assessments}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(JSON.stringify({ decisions })),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      await configureFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)
      const project = (await rpc(control, 'projects.list', {})).find(row => row.name === PROJECT)
      assert.ok(project)
      const catalog = await rpc(control, 'runtime.runner.catalog', {})
      const model = catalog.models.find(row => row.runtime === 'codex' && row.is_default)
      assert.ok(model)
      expectedModel = model.model_id
      const agent = await rpc(control, 'chat_agents.create', {
        project_id: project.id,
        agent: {
          name: '项目统筹负责人',
          runtime: 'codex',
          execution_mode: 'manual_approval',
          created_by_user_id: LOCAL_OWNER,
          execution_policy: { mode: 'project_pool' },
          model_policy: {
            mode: 'fixed',
            model: { runtime: model.runtime, provider: model.provider, model_id: model.model_id },
          },
        },
      })
      assert.equal(agent.execution_mode, 'manual_approval')
      assert.equal(agent.created_by_user_id, LOCAL_OWNER)
      const group = {
        id: 'coordination-group',
        name: '项目验证组',
        instructions: `${WORK_MARKER}。核验当前 Issue 的验收标准后提交待确认，并说明结果。`,
        leader: { kind: 'agent', id: agent.id, name: agent.name },
        members: [],
      }
      await rpc(control, 'projects.update', {
        project_id: project.id,
        project: {
          version: project.version,
          collaboration_groups: [group],
        },
      })
      await rpc(control, 'runtime.stand_in.memory.save', {
        userId: USER,
        memory: {
          scope: { kind: 'project_coordinator', id: project.id, store: 'local' },
          content: PRIVATE,
        },
      })
      const target = {
        userId: USER,
        projectStore: 'local',
        projectId: project.id,
        groupId: group.id,
      }
      await reloadMainWindow(control, 'Load the Native-seeded project and Agent configuration')
      await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-board"]')
      await enterProjectCollaborationView(control, CONTENT)
      await control.command(
        'clickWhenEnabled',
        `[data-testid="collaboration-workspace-project-${project.id}"]`
      )
      await selectCollaborationProjectView(control, CONTENT, 'board')
      await control.command('clickWhenEnabled', '[data-testid="project-coordinator-open"]')
      await control.command('waitFor', '[data-testid="project-coordination-enable"]')
      assert.notEqual(
        (await rpc(control, 'runtime.project_coordinator.binding.get', target)).binding?.enabled,
        true
      )
      await captureScreenshot(control, 'project-coordination-01-explicit-enable-entry.png')
      await control.command('clickWhenEnabled', '[data-testid="project-coordination-enable"]')
      await control.command('waitFor', '[data-testid="project-coordination-check"]')
      const enabled = await rpc(control, 'runtime.project_coordinator.binding.get', target)
      assert.equal(enabled.binding.userId, USER)
      const issue = await rpc(control, 'todos.create', {
        project_id: project.id,
        todo: { title: '验证共享项目权限隔离', description: '请先明确验收标准，再安排小组处理。' },
      })
      await until(
        () => rpc(control, 'runtime.project_coordinator.processing.get', target),
        state => state.lastCheckAt,
        'The real DSH plugin observes this binding'
      )
      assert.equal(
        assessments,
        0,
        'Ordinary events remain silent until the fixed window or explicit check'
      )
      assert.equal(
        (await rpc(control, 'executions.list', { project_id: project.id, include_terminal: true }))
          .length,
        0
      )
      await captureScreenshot(control, 'project-coordination-02-silent-source-no-work.png')
      await control.command('clickWhenEnabled', '[data-testid="project-coordination-check"]')
      await control.command(
        'waitFor',
        `[data-testid="project-coordination-question-${issue.id}"]`,
        { timeoutMs: modelResponseTimeoutMs }
      )
      assert.equal(assessments, 1)
      await until(
        () => rpc(control, 'runtime.project_coordinator.processing.get', target),
        state => !state.running,
        'The clarification assessment settles before capture'
      )
      await control.command('waitFor', '[data-testid="project-coordinator-dialog"]', {
        text: '等待新的项目事件',
      })
      assert.equal(
        (await rpc(control, 'executions.list', { project_id: project.id, include_terminal: true }))
          .length,
        0
      )
      assert.equal(
        (await rpc(control, 'todos.comment.list', { project_id: project.id, task_id: issue.id }))
          .length,
        0,
        'Private request for clarification does not publish automatically'
      )
      await captureScreenshot(
        control,
        'project-coordination-03-private-question-original-issue.png'
      )
      await control.command(
        'clickWhenEnabled',
        `[data-testid="project-coordination-question-${issue.id}"]`
      )
      await control.command('waitFor', `${CONTENT} [data-testid="collaboration-issue-detail"]`, {
        text: issue.title,
      })
      await captureScreenshot(control, 'project-coordination-04-return-to-original-issue.png')
      await rpc(control, 'todos.comment.create', {
        project_id: project.id,
        task_id: issue.id,
        comment: {
          project_id: project.id,
          task_id: issue.id,
          sender_type: 'user',
          sender_id: String(USER),
          sender_name: '验证成员',
          content: CONFIRMED,
          metadata: {},
        },
      })
      await control.command('clickWhenEnabled', '[data-testid="project-coordinator-open"]')
      await control.command('clickWhenEnabled', '[data-testid="project-coordination-check"]')
      const bindings = await until(
        () => rpc(control, 'executions.list', { project_id: project.id, include_terminal: true }),
        rows => rows.length === 1,
        'The accepted intent enters the original Issue queue'
      )
      assert.equal(assessments, 2)
      assert.equal(bindings.length, 1)
      assert.equal(bindings[0].loop_item_id, issue.id)
      assert.equal(
        bindings[0].status,
        'pending_approval',
        'Original manual execution approval is preserved'
      )
      const status = await until(
        () => rpc(control, 'runtime.project_coordinator.processing.get', target),
        state => !state.running,
        'The dispatch receipt settles'
      )
      assert.equal(status.error, null)
      await control.command('clickWhenEnabled', '[data-testid="project-coordinator-work-list"]')
      await control.command('clickWhenEnabled', `[data-testid="cloud-todo-card-${issue.id}"]`)
      await control.command('waitFor', `${CONTENT} [data-testid="collaboration-issue-detail"]`, {
        text: issue.title,
      })
      await control.command('waitFor', `${CONTENT} [data-testid="collaboration-issue-detail"]`, {
        text: '等待审批',
      })
      await captureScreenshot(control, 'project-coordination-05-one-original-issue-work.png')
      await control.command('waitFor', `[data-testid="cloud-task-activity-approve-${issue.id}"]`)
      await control.command(
        'clickWhenEnabled',
        `[data-testid="cloud-task-activity-approve-${issue.id}"]`
      )
      const completed = await until(
        () => rpc(control, 'executions.list', { project_id: project.id, include_terminal: true }),
        rows => rows.some(row => row.id === bindings[0].id && row.status === 'completed'),
        'The approved original execution actually completes through Native'
      )
      assert.equal(completed.length, 1)
      assert.equal(completed[0].assigner_user_id, USER)
      assert.ok(completed[0].runtime_task_id)
      assert.ok(workRequests > 0)
      await control.command('waitFor', `${CONTENT} [data-testid="collaboration-issue-detail"]`, {
        text: WORK_RESULT,
        timeoutMs: modelResponseTimeoutMs,
      })
      const resultComments = await rpc(control, 'todos.comment.list', {
        project_id: project.id,
        task_id: issue.id,
      })
      const outcome = resultComments.find(
        comment =>
          comment.content === WORK_RESULT &&
          comment.metadata.activity_type === 'manager_status_comment'
      )
      assert.ok(outcome, 'The scoped manager tool published the result to the original Issue')
      const resultSelector = `[data-testid="cloud-task-activity-message-${outcome.message_id}"]`
      await control.command('waitFor', resultSelector, { text: WORK_RESULT })
      await control.command('scrollIntoView', resultSelector)
      assert.equal(
        (await rpc(control, 'todos.get', { project_id: project.id, task_id: issue.id })).status,
        'in_review'
      )
      await captureScreenshot(
        control,
        'project-coordination-05b-approved-original-work-completed.png'
      )
      const acceptSelector = `[data-testid="cloud-task-activity-accept-${issue.id}"]`
      await control.command('scrollIntoView', acceptSelector)
      await control.command('clickWhenEnabled', acceptSelector)
      await until(
        () => rpc(control, 'todos.get', { project_id: project.id, task_id: issue.id }),
        item => item.status === 'completed',
        'The human accepts the result through the original Issue flow'
      )
      await captureScreenshot(control, 'project-coordination-05c-human-accepted-result.png')
      await control.command('clickWhenEnabled', '[data-testid="project-coordinator-open"]')
      await control.command('waitFor', '[data-testid="project-coordination-check"]')
      await control.command('clickWhenEnabled', '[data-testid="project-coordination-check"]')
      await until(
        () => rpc(control, 'runtime.project_coordinator.processing.get', target),
        state => !state.running,
        'Checking existing work does not create a new assessment'
      )
      assert.equal(assessments, 2)
      assert.equal(
        (await rpc(control, 'executions.list', { project_id: project.id, include_terminal: true }))
          .length,
        1
      )
      // Switch the real hosting device instead of impersonating another member.
      // The original binding remains persisted and must require explicit takeover.
      await restartDesktopApp({
        appEnvironmentOverrides: { WEWORK_USER_DATA_DIR: join(resultDir, 'device-b-user-data') },
        expectNewDeviceIdentity: true,
      })
      await control.command('waitFor', '[data-testid="telemetry-consent-decline"]')
      await control.command('clickWhenEnabled', '[data-testid="telemetry-consent-decline"]')
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-board"]')
      await enterProjectCollaborationView(control, CONTENT)
      await control.command(
        'clickWhenEnabled',
        `[data-testid="collaboration-workspace-project-${project.id}"]`
      )
      await control.command('clickWhenEnabled', '[data-testid="project-coordinator-open"]')
      await control.command('waitFor', '[data-testid="project-coordination-enable"]', {
        text: '接管',
      })
      await captureScreenshot(control, 'project-coordination-06-other-device-binding.png')
      const before = await rpc(control, 'runtime.project_coordinator.binding.get', target)
      await control.command('clickWhenEnabled', '[data-testid="project-coordination-enable"]')
      await control.command('waitFor', '[data-testid="project-coordination-takeover-confirm"]')
      assert.equal(
        (await rpc(control, 'runtime.project_coordinator.binding.get', target)).binding.generation,
        before.binding.generation
      )
      await captureScreenshot(control, 'project-coordination-07-explicit-takeover-confirmation.png')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="project-coordination-takeover-confirm-cancel-button"]'
      )
      await control.command('waitFor', '[data-testid="project-coordination-takeover-confirm"]', {
        visible: false,
      })
      assert.deepEqual(
        (await rpc(control, 'runtime.project_coordinator.binding.get', target)).binding,
        before.binding,
        'Cancelling takeover must preserve the existing effective binding'
      )
      await captureScreenshot(control, 'project-coordination-07b-cancel-preserves-binding.png')
      await control.command('clickWhenEnabled', '[data-testid="project-coordination-enable"]')
      await control.command('waitFor', '[data-testid="project-coordination-takeover-confirm"]')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="project-coordination-takeover-confirm"]'
      )
      await control.command('waitFor', '[data-testid="project-coordination-check"]')
      const taken = await rpc(control, 'runtime.project_coordinator.binding.get', target)
      assert.equal(taken.binding.userId, USER)
      assert.notEqual(taken.binding.deviceId, enabled.binding.deviceId)
      assert.notEqual(taken.binding.generation, before.binding.generation)
      await captureScreenshot(control, 'project-coordination-08-single-active-binding.png')
      await control.command('clickWhenEnabled', '[data-testid="project-coordination-stop"]')
      await control.command('waitFor', '[data-testid="project-coordination-enable"]', {
        text: '让负责人自动处理',
      })
      assert.equal(
        (await rpc(control, 'runtime.project_coordinator.binding.get', target)).binding.enabled,
        false
      )
      await captureScreenshot(control, 'project-coordination-09-stopped.png')
      return { assessments, originalIssueId: issue.id, bindings: bindings.length, workRequests }
    },
  }
}
