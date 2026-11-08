import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { DEFAULT_MODEL_ID } from '../modules/shared.mjs'
import { createCollaborationBoardIssue } from '../modules/collaboration-board-issue.mjs'
import {
  createLocalCollaborationProject,
  configureFirstProjectExecutionEnvironment,
  reloadMainWindow,
  selectCollaborationProjectView,
} from '../modules/workspace-flows.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectTool,
  selectedToolCall,
} from '../modules/response-protocol.mjs'

const MARKER = 'ISSUE_HUMAN_HANDOFF_NATIVE_EXECUTION'
const QUESTION = '这个 Issue 的交付范围由你决定，请确认只交付内部版本还是公开发布。'
const ANSWER = '只交付内部版本，不公开发布。'
const CALL = 'issue-human-handoff-question'
const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const testId = id => `[data-testid=${JSON.stringify(id)}]`
const scoped = id => `${ACTIVE} ${testId(id)}`
const fullyVisible = box =>
  box?.hitTestVisible === true &&
  box.visibleIntersection?.width >= box.width - 1 &&
  box.visibleIntersection?.height >= box.height - 1

export const HUMAN_HANDOFF_USER_STORIES = [
  'creator-owns-idle-issue-without-invented-ai-progress',
  'project-quick-filter-matches-the-current-human',
  'project-work-appears-in-the-global-pending-tab',
  'native-question-is-persistent-and-targeted',
  'reporting-ai-marks-blocking-without-changing-the-recipient-or-clock',
  'transfer-has-an-exact-handoff-time-and-audit-trail',
  'queued-answer-does-not-complete-the-handoff',
  'accepted-answer-resumes-the-original-thread-exactly-once',
]

/**
 * Preconditions: isolated local project, native storage and a real robot execution.
 * Only model HTTP is synthetic. Hold its independent-work response open to prove
 * a queued answer is not accepted. Native transfer RPCs create real assignment
 * transitions; no question metadata or native lifecycle state is rewritten.
 * Recovery reloads run before and after answering. The shared runner removes the
 * isolated executor home; finally always releases held model response streams.
 */
export function createDesktopScenario({
  executorHome,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  resultDir,
  captureScreenshot,
}) {
  let active = false
  let executionContext
  let blockingBefore
  let blockingAfter
  let listAttempt = 0
  const held = []
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const readQuestions = (control, project, issue) =>
    rpc(control, 'todos.humanRequests.list', { project_id: project.id, task_id: issue.id })
  async function until(load, ready, label, timeoutMs = uiTimeoutMs) {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      last = await load()
      if (ready(last)) return last
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail(`${label}: ${JSON.stringify(last)}`)
  }
  function finishIndependentWork() {
    for (const stream of held.splice(0)) {
      if (!stream.response.writableEnded)
        stream.response.end(createSse([responseCompleted(stream.id, stream.output)]))
    }
  }
  async function openPending(control) {
    await control.command('clickWhenEnabled', testId('workspace-tab-select-pending-interactions'))
    await control.command('waitFor', scoped('runtime-interactions-page'))
    await control.command('clickWhenEnabled', scoped('interactions-refresh'))
  }
  async function recordSurface(control, name, selectors) {
    await captureScreenshot(control, `${name}.png`, 'body')
    const metrics = await Promise.all(
      selectors.map(async selector => ({
        selector,
        elements: JSON.parse(await control.command('getElementMetrics', selector)),
      }))
    )
    await writeFile(join(resultDir, `${name}.metrics.json`), JSON.stringify(metrics, null, 2))
  }
  async function recordPendingRows(control, expectedQuestions = 1, phase = 'pending') {
    const rows = []
    const expectedProjects = phase === 'pending' ? 1 : 2
    await until(
      async () => ({
        questions: Number(
          await control.command(
            'getElementCount',
            `${scoped('interaction-list-item')}:not([data-project-issue="true"])`
          )
        ),
        projects: Number(
          await control.command(
            'getElementCount',
            `${scoped('interaction-list-item')}[data-project-issue="true"]`
          )
        ),
      }),
      value => value.questions === expectedQuestions && value.projects === expectedProjects,
      'Question and project sources must both finish refreshing their exact expected pending rows'
    )
    const rowCount = Number(
      await control.command('getElementCount', scoped('interaction-list-item'))
    )
    let selector = scoped('interaction-list-item')
    while (JSON.parse(await control.command('getElementMetrics', selector)).length) {
      const id = await control.command('getAttribute', selector, { value: 'data-interaction-id' })
      assert.ok(id, 'Each pending row must expose its stable interaction identity')
      const exact = `${scoped('interaction-list-item')}[data-interaction-id=${JSON.stringify(id)}]`
      rows.push({
        id,
        projectIssue: await control.command('getAttribute', selector, {
          value: 'data-project-issue',
        }),
        text: await control.command('getText', exact),
      })
      selector += `:not([data-interaction-id=${JSON.stringify(id)}])`
    }
    await writeFile(
      join(resultDir, `issue-handoff-${phase}-rows.json`),
      JSON.stringify(rows, null, 2)
    )
    assert.equal(
      rows.filter(row => row.text.includes(QUESTION)).length,
      expectedQuestions,
      'Native and canonical sources must share one question and remove it after acceptance'
    )
    assert.equal(
      rows.length,
      rowCount,
      'Each rendered pending row must have a distinct stable identity'
    )
    assert.equal(
      new Set(rows.map(row => row.id)).size,
      rows.length,
      'Pending rows must have unique identities'
    )
    assert.equal(
      rows.filter(row => row.projectIssue === 'true').length,
      expectedProjects,
      'Only the original creator-owned Issue is pending before acceptance; the completed AI turn then returns its Issue to its human owner'
    )
  }
  async function verifyHeader(control, issueId, kind, name) {
    const header = scoped(`cloud-todo-card-header-${issueId}`)
    const actors = `${header} ${testId(`cloud-todo-card-header-actors-${issueId}`)}`
    const actor = `${actors} ${testId(`issue-participation-${issueId}`)}`
    await control.command('waitFor', `${actor}[data-processing-kind="${kind}"]`, { text: name })
    const [headerBox] = JSON.parse(await control.command('getElementMetrics', header))
    const [actorBox] = JSON.parse(await control.command('getElementMetrics', actor))
    assert.ok(actorBox.top >= headerBox.top && actorBox.bottom <= headerBox.bottom + 1)
    assert.ok(
      actorBox.left + actorBox.width / 2 > headerBox.left + headerBox.width / 2,
      'The actor must be at the right of the existing header, not in a new row'
    )
    const text = await control.command('getText', actor)
    assert.ok(!text.includes('AI 处理中'))
    assert.ok(!text.includes('#0'))
  }
  return {
    async prepareApp() {
      await mkdir(join(executorHome, 'capabilities'), { recursive: true })
      await writeFile(
        join(executorHome, 'capabilities', 'model-catalog-overrides.json'),
        JSON.stringify([
          {
            slug: DEFAULT_MODEL_ID,
            fields: { experimental_supported_tools: ['request_user_input_async'] },
          },
        ])
      )
      await rm(join(executorHome, 'codex', 'models_cache.json'), { force: true })
    },
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const text = JSON.stringify(body.input ?? body.messages ?? [])
      if (!text.includes(MARKER)) return false
      const id = `issue-human-handoff-${Date.now()}`
      if (!text.includes(ANSWER) && requestContainsToolOutput(body, CALL)) {
        const listCall = `handoff-list-${listAttempt}`
        if (!blockingBefore && requestContainsToolOutput(body, listCall)) {
          const listed = JSON.parse(readMcpToolOutput(body, listCall))
          assert.ok(!listed.error && !listed.isError, JSON.stringify(listed))
          blockingBefore = listed.items.find(item => item.root_comment_id === executionContext.root)
          if (!blockingBefore) listAttempt++
        }
        if (requestContainsToolOutput(body, 'handoff-mark-blocking')) {
          blockingAfter = JSON.parse(readMcpToolOutput(body, 'handoff-mark-blocking'))
          assert.equal(blockingAfter.blocks_progress, true)
          assert.equal(blockingAfter.recipient_user_id, blockingBefore.recipient_user_id)
          assert.equal(blockingAfter.waiting_since, blockingBefore.waiting_since)
        }
        if (!blockingAfter) {
          const toolName = blockingBefore ? 'set_human_request_blocking' : 'list_human_requests'
          const argumentsValue = {
            space_id: executionContext.project,
            item_id: executionContext.issue,
            ...(blockingBefore
              ? {
                  request_id: blockingBefore.id,
                  version: blockingBefore.version,
                  runtime_device_id: blockingBefore.runtime_device_id,
                  blocks_progress: true,
                }
              : {}),
          }
          const toolCallId = blockingBefore
            ? 'handoff-mark-blocking'
            : `handoff-list-${listAttempt}`
          const selected = mcpToolRequestEvents(body, {
            toolName,
            argumentsValue,
            directToolName: `mcp__wework_space__${toolName}`,
            searchCallId: `${toolCallId}-search`,
            toolCallId,
          })
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
          response.end(createSse([responseCreated(id), ...selected.events, responseCompleted(id)]))
          return true
        }
        assert.equal(held.length, 0, 'Independent model work must not be launched twice')
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        const progress = assistantMessage('独立检查仍在进行，依赖发布范围的步骤等待人工答复。')
        response.write(createSse([responseCreated(id), progress]))
        held.push({ id, response, output: [progress.item] })
        return true
      }
      const events = text.includes(ANSWER)
        ? [assistantMessage('已接收原 Issue 的人工答复，只交付内部版本。')]
        : selectedToolCall(
            CALL,
            selectTool(body, 'request_user_input_async', {
              questions: [{ title: QUESTION, options: ['内部版本', '公开发布'] }],
            })
          )
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      active = true
      try {
        const profileResponse = await fetch(
          `http://127.0.0.1:${process.env.WEWORK_E2E_MODEL_SERVER_PORT}/api/users/me`
        )
        assert.ok(profileResponse.ok)
        const profile = await profileResponse.json()
        const viewerId = Number(profile.id)
        const viewerName = profile.user_name
        assert.ok(Number.isInteger(viewerId) && viewerId > 0)
        const otherId = viewerId === 7 ? 8 : 7
        await ensureExperimentalFeaturesEnabled(control)
        await control.command(
          'clickWhenEnabled',
          '[data-testid="workspace-tab-select-fixed-board"]'
        )
        const name = `人工介入闭环-${process.pid}`
        await createLocalCollaborationProject(control, ACTIVE, name)
        await configureFirstProjectExecutionEnvironment(control, ACTIVE, uiTimeoutMs)
        await selectCollaborationProjectView(control, ACTIVE, 'board', uiTimeoutMs)
        const project = (await rpc(control, 'projects.list', {})).find(
          project => project.name === name
        )
        assert.ok(project)
        const ordinaryTitle = `原生项目待办-${process.pid}`
        const ordinaryId = await createCollaborationBoardIssue(
          control,
          ordinaryTitle,
          'inbox',
          uiTimeoutMs
        )
        const foreign = await rpc(control, 'todos.create', {
          project_id: project.id,
          todo: { title: `其他人负责-${process.pid}`, assignee_user_id: otherId },
        })
        await reloadMainWindow(control, 'Restore native Issue ownership fixtures')
        await verifyHeader(control, ordinaryId, 'human', 'local')
        await control.command('waitFor', scoped(`cloud-todo-card-${foreign.id}`))
        const filter = scoped('project-needs-my-input-filter')
        await control.command('clickWhenEnabled', filter)
        await control.command('waitFor', `${filter}[aria-pressed="true"]`)
        await control.command('waitFor', scoped(`cloud-todo-card-${ordinaryId}`))
        await control.command('waitFor', scoped(`cloud-todo-card-${foreign.id}`), {
          visible: false,
        })
        await recordSurface(control, 'issue-handoff-01-project-filter', [
          scoped('cloud-board-toolbar'),
          filter,
          scoped(`cloud-todo-card-header-${ordinaryId}`),
          scoped(`issue-participation-${ordinaryId}`),
        ])
        const boardSize = await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify({ width: 480, height: 760 }),
        })
        try {
          await until(
            async () => JSON.parse(await control.command('getElementMetrics', filter))[0],
            value => value?.width > 0 && value.viewportWidth <= 480,
            'The personal project filter must remain visible in a narrow window'
          )
          const actor = scoped(`issue-participation-${ordinaryId}`)
          await control.command('scrollIntoViewAsUser', actor)
          await until(
            async () => JSON.parse(await control.command('getElementMetrics', actor))[0],
            fullyVisible,
            'The narrow actor must be hit-testable and fully inside every ancestor scrollport'
          )
          await recordSurface(control, 'issue-handoff-01b-narrow-project-filter', [
            scoped('cloud-board-toolbar'),
            scoped('cloud-board-scroll-area'),
            scoped('cloud-todo-column-dropzone-inbox-viewport'),
            filter,
            scoped(`cloud-todo-card-header-${ordinaryId}`),
            scoped(`issue-participation-${ordinaryId}`),
          ])
        } finally {
          await control.command('setMainWindowSize', 'body', { value: boardSize })
        }
        await control.command('clickWhenEnabled', filter)
        await control.command('waitFor', scoped(`cloud-todo-card-${foreign.id}`))
        await openPending(control)
        const ordinaryKey = `project-issue:local:${project.id}:${ordinaryId}`
        const pendingIssue = `${scoped('interaction-list-item')}[data-project-issue="true"][data-interaction-id=${JSON.stringify(ordinaryKey)}]`
        await control.command('waitFor', pendingIssue, { text: ordinaryTitle })
        const ordinary = await rpc(control, 'todos.get', {
          project_id: project.id,
          task_id: ordinaryId,
        })
        const waitingTime = `${pendingIssue} ${testId('issue-waiting-time')}`
        await control.command('waitFor', waitingTime)
        assert.equal(
          Date.parse(await control.command('getAttribute', waitingTime, { value: 'datetime' })),
          Date.parse(ordinary.created_at)
        )
        await control.command('clickWhenEnabled', pendingIssue, { text: ordinaryTitle })
        await control.command('waitFor', scoped('work-item-context-panel'))
        await recordSurface(control, 'issue-handoff-02-project-pending', [
          scoped('runtime-interactions-page'),
          pendingIssue,
          scoped('work-item-context-panel'),
        ])
        assert.equal(
          await control.command(
            'getAttribute',
            testId('workspace-tab-select-pending-interactions'),
            { value: 'aria-selected' }
          ),
          'true'
        )
        await control.command('clickWhenEnabled', testId('workspace-tab-select-fixed-board'))
        await control.command('waitFor', scoped('cloud-project-header-title'), { text: name })
        const catalog = await rpc(control, 'runtime.runner.catalog', {})
        const model = catalog.models.find(
          model => model.runtime === 'codex' && model.model_id === DEFAULT_MODEL_ID
        )
        assert.ok(model)
        const agent = await rpc(control, 'chat_agents.create', {
          project_id: project.id,
          agent: {
            name: '人工介入验证机器人',
            runtime: 'codex',
            execution_mode: 'auto',
            created_by_user_id: 0,
            execution_policy: { mode: 'project_pool' },
            model_policy: {
              mode: 'fixed',
              model: { runtime: model.runtime, provider: model.provider, model_id: model.model_id },
            },
          },
        })
        const issue = await rpc(control, 'todos.create', {
          project_id: project.id,
          todo: { title: '验证人工介入闭环', description: MARKER },
        })
        const root = await rpc(control, 'todos.comment.create', {
          comment: {
            project_id: project.id,
            task_id: issue.id,
            sender_type: 'user',
            sender_id: '0',
            sender_name: 'local',
            content: MARKER,
            metadata: { mentions: [{ type: 'agent', id: agent.id, label: agent.name }] },
          },
        })
        executionContext = { project: project.id, issue: issue.id, root: root.message_id }
        await rpc(control, 'executions.enqueue', {
          project_id: project.id,
          task_id: issue.id,
          agent_id: agent.id,
          trigger_message_id: root.message_id,
          payload: { message: MARKER },
        })
        const questions = await until(
          () =>
            rpc(control, 'todos.humanRequests.list', { project_id: project.id, task_id: issue.id }),
          result => result.items.length === 1,
          'The native question must become an Issue-owned record',
          modelResponseTimeoutMs
        )
        const question = questions.items[0]
        const interactionId = JSON.stringify([
          question.runtime_device_id,
          question.runtime_task_id,
          `item:${question.item_id}`,
        ])
        const pendingQuestion = `${scoped('interaction-list-item')}[data-interaction-id=${JSON.stringify(interactionId)}]`
        assert.equal(question.recipient_user_id, null)
        assert.equal(question.root_comment_id, root.message_id)
        assert.equal(question.questions[0].options[0].label, '内部版本')
        assert.ok(question.waiting_since)
        await until(
          async () => held.length,
          count => count === 1,
          'Independent model work must remain running',
          modelResponseTimeoutMs
        )
        const flagged = (await readQuestions(control, project, issue)).items[0]
        assert.equal(flagged.blocks_progress, true)
        assert.equal(flagged.recipient_user_id, question.recipient_user_id)
        assert.equal(flagged.waiting_since, question.waiting_since)
        const runtime = await rpc(control, 'runtime.tasks.transcript', {
          taskId: question.runtime_task_id,
          limit: 5,
        })
        assert.ok(runtime.origin, 'The real Runtime transcript must retain its Issue origin')
        await writeFile(
          join(resultDir, 'issue-handoff-source-identity.json'),
          JSON.stringify(
            {
              projectId: project.id,
              issueId: issue.id,
              request: flagged,
              runtimeOrigin: runtime.origin,
            },
            null,
            2
          )
        )
        await reloadMainWindow(control, 'Restore the persisted Issue question')
        await control.command('clickWhenEnabled', '[data-testid="wework-notifications-button"]')
        await control.command('waitFor', '[data-testid="wework-notifications-pending"]', {
          text: QUESTION,
        })
        await control.command('clickWhenEnabled', '[data-testid="wework-notifications-pending"]')
        await control.command('waitFor', scoped('runtime-interactions-page'))
        await recordPendingRows(control)
        const surface = `${ACTIVE} [data-testid="issue-human-request-${question.id}"]`
        await control.command('waitFor', surface, { text: QUESTION })
        assert.equal(
          (await readQuestions(control, project, issue)).items[0].status,
          'pending',
          'Reading the notification or original Issue must not complete its question'
        )
        await recordSurface(control, 'issue-handoff-02b-awaiting-explicit-assignment', [surface])
        await control.command(
          'select',
          `${surface} [data-testid="issue-human-request-assignee-${question.id}"]`,
          { value: String(viewerId) }
        )
        const assigned = await until(
          () =>
            rpc(control, 'todos.humanRequests.list', { project_id: project.id, task_id: issue.id }),
          result => result.items[0].recipient_user_id === viewerId,
          'Assignment must persist before answering'
        )
        const first = assigned.items[0]
        await recordSurface(control, 'issue-handoff-02c-assigned-to-current-profile', [surface])
        const transferred = await rpc(control, 'todos.humanRequests.assign', {
          project_id: project.id,
          task_id: issue.id,
          request_id: question.id,
          version: first.version,
          recipient_user_id: otherId,
          recipient_name: 'Other recipient',
        })
        assert.equal(transferred.waiting_since, transferred.updated_at)
        assert.ok(
          !(await rpc(control, 'todos.humanRequests.inbox', { user_id: viewerId })).items.some(
            item => item.id === question.id
          )
        )
        assert.ok(
          (await rpc(control, 'todos.humanRequests.inbox', { user_id: otherId })).items.some(
            item => item.id === question.id
          )
        )
        await openPending(control)
        await control.command('waitFor', pendingQuestion, { visible: false })
        const returned = await rpc(control, 'todos.humanRequests.assign', {
          project_id: project.id,
          task_id: issue.id,
          request_id: question.id,
          version: transferred.version,
          recipient_user_id: viewerId,
          recipient_name: viewerName,
        })
        assert.equal(returned.waiting_since, returned.updated_at)
        assert.deepEqual(
          returned.events
            .filter(event => event.type === 'assigned')
            .slice(-2)
            .map(event => [event.from_user_id, event.to_user_id]),
          [
            [viewerId, otherId],
            [otherId, viewerId],
          ]
        )
        await openPending(control)
        await control.command('waitFor', pendingQuestion, { text: QUESTION })
        await control.command(
          'waitFor',
          `${pendingQuestion} [data-testid="issue-waiting-time"][datetime=${JSON.stringify(returned.waiting_since)}]`
        )
        await control.command('clickWhenEnabled', pendingQuestion)
        await control.command('waitFor', surface, { text: QUESTION })
        await recordSurface(control, 'issue-handoff-03-targeted-question', [
          scoped('runtime-interactions-page'),
          pendingQuestion,
          surface,
          `${surface} ${testId(`issue-human-request-assignee-${question.id}`)}`,
          `${surface} ${testId('request-user-input-submit-button')}`,
        ])
        const previousSize = await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify({ width: 480, height: 760 }),
        })
        try {
          await control.command('scrollIntoViewAsUser', surface)
          const narrow = await until(
            async () => JSON.parse(await control.command('getElementMetrics', surface))[0],
            value => value?.viewportWidth <= 480 && fullyVisible(value),
            'The narrow question must be hit-testable and fully inside every ancestor scrollport'
          )
          for (const target of [
            `${surface} ${testId(`issue-human-request-assignee-${question.id}`)}`,
            `${surface} ${testId('request-user-input-submit-button')}`,
          ]) {
            const [metrics] = JSON.parse(await control.command('getElementMetrics', target))
            assert.ok(
              fullyVisible(metrics),
              `The narrow question control must actually be visible: ${target}`
            )
            assert.ok(metrics.width >= 44 && metrics.height >= 44)
          }
          assert.ok(
            narrow.scrollWidth <= narrow.clientWidth + 1,
            'The question card must not overflow horizontally'
          )
          await recordSurface(control, 'issue-handoff-03b-narrow-question', [
            scoped('runtime-interactions-page'),
            surface,
            `${surface} ${testId(`issue-human-request-assignee-${question.id}`)}`,
            `${surface} ${testId('request-user-input-submit-button')}`,
          ])
        } finally {
          await control.command('setMainWindowSize', 'body', { value: previousSize })
        }
        const input = `${surface} [data-testid="request-user-input-custom-${question.questions[0].id}"]`
        await control.command('waitFor', `${input}:not(:disabled)`)
        await control.command('fill', input, { value: ANSWER })
        await control.command(
          'clickWhenEnabled',
          `${surface} [data-testid="request-user-input-submit-button"]`
        )
        const queued = (
          await until(
            () => readQuestions(control, project, issue),
            result => result.items[0].status === 'answering',
            'A saved, queued answer must not resolve the handoff'
          )
        ).items[0]
        assert.ok(queued.answer_message_id)
        assert.equal(queued.waiting_since, returned.waiting_since)
        assert.equal(
          held.length,
          1,
          'The original model turn must still be running while the answer is queued'
        )
        await recordSurface(control, 'issue-handoff-04-answer-queued', [
          scoped('runtime-interactions-page'),
          surface,
        ])
        finishIndependentWork()
        const settled = await until(
          () =>
            rpc(control, 'todos.humanRequests.list', { project_id: project.id, task_id: issue.id }),
          result => result.items[0].status === 'resolved',
          'Only the owning Runtime acceptance resolves the question',
          modelResponseTimeoutMs
        )
        assert.ok(settled.items[0].answer_message_id)
        assert.equal(settled.items[0].runtime_task_id, question.runtime_task_id)
        assert.equal(settled.items[0].answer_message_id, queued.answer_message_id)
        assert.deepEqual(
          settled.items[0].events.slice(-2).map(event => event.type),
          ['answered', 'accepted']
        )
        const comments = await rpc(control, 'todos.comment.list', {
          project_id: project.id,
          task_id: issue.id,
          after_sequence: 0,
        })
        const answers = comments.filter(
          comment => comment.sender_type === 'user' && comment.content.includes(ANSWER)
        )
        assert.equal(answers.length, 1)
        assert.equal(
          answers[0].sender_id,
          String(viewerId),
          'The answer must use the actual profile, not impersonate native owner 0'
        )
        assert.equal(answers[0].thread_root_message_id, root.message_id)
        await until(
          () => rpc(control, 'runtime.tasks.get', { taskId: question.runtime_task_id }),
          value => value.task?.status === 'done',
          'The accepted answer must finish its original Runtime turn before checking human-owned ordinary Issues',
          modelResponseTimeoutMs
        )
        await openPending(control)
        await until(
          () => control.command('getText', scoped('interaction-list-item')),
          text => !text.includes(QUESTION),
          'Accepted questions must disappear from the global pending UI, not only the native inbox'
        )
        await recordPendingRows(control, 0, 'accepted')
        await reloadMainWindow(control, 'Answered questions remain resolved after reload')
        const inbox = await rpc(control, 'todos.humanRequests.inbox', { user_ids: [0, viewerId] })
        assert.ok(!inbox.items.some(request => request.id === question.id))
        await openPending(control)
        await until(
          () => control.command('getText', scoped('interaction-list-item')),
          text => !text.includes(QUESTION),
          'Accepted questions must not return to the global pending UI after reload'
        )
        await recordPendingRows(control, 0, 'reloaded')
        await recordSurface(control, 'issue-handoff-05-resolved', [
          scoped('runtime-interactions-page'),
        ])
      } finally {
        finishIndependentWork()
        active = false
      }
    },
  }
}
