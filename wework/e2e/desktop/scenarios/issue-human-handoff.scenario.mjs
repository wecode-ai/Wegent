import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
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

export const HUMAN_HANDOFF_USER_STORIES = [
  'creator-owns-idle-issue-without-invented-ai-progress',
  'project-quick-filter-matches-the-current-human',
  'project-work-appears-in-the-global-pending-tab',
  'native-question-is-persistent-and-targeted',
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
          todo: { title: `其他人负责-${process.pid}`, assignee_user_id: 7 },
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
        await reloadMainWindow(control, 'Restore the persisted Issue question')
        await control.command('clickWhenEnabled', '[data-testid="wework-notifications-button"]')
        await control.command('waitFor', '[data-testid="wework-notifications-pending"]', {
          text: QUESTION,
        })
        await control.command('clickWhenEnabled', '[data-testid="wework-notifications-pending"]')
        const surface = `${ACTIVE} [data-testid="issue-human-request-${question.id}"]`
        await control.command('waitFor', surface, { text: QUESTION })
        assert.equal(
          (await readQuestions(control, project, issue)).items[0].status,
          'pending',
          'Reading the notification or original Issue must not complete its question'
        )
        await control.command(
          'select',
          `${surface} [data-testid="issue-human-request-assignee-${question.id}"]`,
          { value: '0' }
        )
        const assigned = await until(
          () =>
            rpc(control, 'todos.humanRequests.list', { project_id: project.id, task_id: issue.id }),
          result => result.items[0].recipient_user_id === 0,
          'Assignment must persist before answering'
        )
        const first = assigned.items[0]
        const transferred = await rpc(control, 'todos.humanRequests.assign', {
          project_id: project.id,
          task_id: issue.id,
          request_id: question.id,
          version: first.version,
          recipient_user_id: 7,
          recipient_name: 'Other recipient',
        })
        assert.equal(transferred.waiting_since, transferred.updated_at)
        assert.ok(
          !(await rpc(control, 'todos.humanRequests.inbox', { user_id: 0 })).items.some(
            item => item.id === question.id
          )
        )
        assert.ok(
          (await rpc(control, 'todos.humanRequests.inbox', { user_id: 7 })).items.some(
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
          recipient_user_id: 0,
          recipient_name: 'local',
        })
        assert.equal(returned.waiting_since, returned.updated_at)
        assert.deepEqual(
          returned.events
            .filter(event => event.type === 'assigned')
            .slice(-2)
            .map(event => [event.from_user_id, event.to_user_id]),
          [
            [0, 7],
            [7, 0],
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
        ])
        const previousSize = await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify({ width: 480, height: 760 }),
        })
        try {
          const narrow = await until(
            async () => JSON.parse(await control.command('getElementMetrics', surface))[0],
            value => value?.width > 0 && value.viewportWidth <= 480,
            'The selected Issue question must remain visible in a narrow window'
          )
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
        assert.equal(answers[0].thread_root_message_id, root.message_id)
        await reloadMainWindow(control, 'Answered questions remain resolved after reload')
        const inbox = await rpc(control, 'todos.humanRequests.inbox', { user_id: 0 })
        assert.ok(!inbox.items.some(request => request.id === question.id))
      } finally {
        finishIndependentWork()
        active = false
      }
    },
  }
}
