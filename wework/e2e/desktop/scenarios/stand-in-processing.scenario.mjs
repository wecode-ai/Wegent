import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { waitForTaskRowByText } from '../modules/task-state-flows.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import {
  assistantMessage,
  createSse,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const USER = 9001
const ROLE = 'silent-review'
const MARKER = 'SILENT_INTAKE_REAL_ASSIGNMENT'
const FOLLOWUP = 'SILENT_PROGRESS_CHECK'

export function createDesktopScenario({
  captureScreenshot,
  workspacePath,
  executorHome,
  uiTimeoutMs,
  modelResponseTimeoutMs,
}) {
  let round = 1
  let coordinatorCalls = 0
  let workCalls = 0
  let ordinaryTaskId
  let createdTaskId
  let intake
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  async function waitFor(read, ready, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let latest
    while (Date.now() < deadline) {
      latest = await read()
      if (ready(latest)) return latest
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail(`Silent processing did not reach its expected state: ${JSON.stringify(latest)}`)
  }
  return {
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input ?? [])
      let events
      if (input.includes('Review this silent intake batch')) {
        coordinatorCalls++
        const readId = `silent-read-${round}`
        const actionId = `silent-action-${round}`
        if (requestContainsToolOutput(body, actionId)) {
          const action = JSON.parse(readMcpToolOutput(body, actionId))
          assert.equal(action.status, 'pending', 'MCP must persist a real dispatch intent')
          events = [assistantMessage('已安排具体工作。')]
          round++
        } else if (requestContainsToolOutput(body, readId)) {
          intake = JSON.parse(readMcpToolOutput(body, readId)).snapshot
          const eventIds = intake.events.map(event => event.id)
          const taskId = intake.works[0]?.taskId
          const name = round === 1 ? 'create_work' : 'continue_work'
          if (round === 1) assert.ok(intake.events.some(event => event.kind === 'assignment'))
          else assert.ok(taskId, 'The second batch must expose the original work conversation')
          events = mcpToolRequestEvents(body, {
            toolName: name,
            directToolName: `mcp__wework_stand_in__${name}`,
            argumentsValue:
              round === 1
                ? { eventIds, roleId: ROLE, title: MARKER }
                : { eventIds, taskId, message: FOLLOWUP },
            searchCallId: `silent-action-search-${round}`,
            toolCallId: actionId,
          }).events
        } else {
          events = mcpToolRequestEvents(body, {
            toolName: 'read_intake',
            directToolName: 'mcp__wework_stand_in__read_intake',
            argumentsValue: {},
            searchCallId: `silent-read-search-${round}`,
            toolCallId: readId,
          }).events
        }
      } else if (input.includes('PRIMARY_ORCHESTRATE_TASK')) {
        const followup = input.includes('PRIMARY_ORCHESTRATE_TASK_CONTINUE')
        const callId = followup ? 'primary-continue-task' : 'primary-create-task'
        if (requestContainsToolOutput(body, callId)) {
          const result = JSON.parse(readMcpToolOutput(body, callId))
          assert.equal(result.success, true, 'Task orchestration must actually succeed')
          if (!followup) createdTaskId = result.taskId
          events = [
            assistantMessage(followup ? '已在原任务追加进度追问。' : '已创建独立处理任务。'),
          ]
        } else {
          const name = followup ? 'continue_task' : 'create_task'
          events = mcpToolRequestEvents(body, {
            toolName: name,
            directToolName: `mcp__wework_stand_in__${name}`,
            argumentsValue: followup
              ? {
                  requestId: 'ordinary-followup',
                  taskId: ordinaryTaskId,
                  message: 'ORDINARY_PROGRESS_CHECK',
                }
              : {
                  requestId: 'new-concrete-task',
                  title: '主分身安排的具体工作',
                  message: 'PRIMARY_CONCRETE_WORK',
                },
            searchCallId: `${callId}-search`,
            toolCallId: callId,
          }).events
        }
      } else if (
        input.includes('PRIMARY_CONCRETE_WORK') ||
        input.includes('ORDINARY_PROGRESS_CHECK')
      ) {
        events = [
          assistantMessage(
            input.includes('ORDINARY_PROGRESS_CHECK')
              ? 'ORDINARY_FOLLOWUP_DONE'
              : 'PRIMARY_CONCRETE_DONE'
          ),
        ]
      } else if (input.includes(MARKER) || input.includes(FOLLOWUP)) {
        workCalls++
        events = [
          assistantMessage(input.includes(FOLLOWUP) ? 'SILENT_FOLLOWUP_DONE' : 'SILENT_WORK_DONE'),
        ]
      } else return false
      const id = `silent-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const initial = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
      const project = await rpc(control, 'projects.create', {
        name: `Silent intake ${process.pid}`,
      })
      try {
        const catalog = await rpc(control, 'runtime.runner.catalog', {})
        const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
        assert.ok(model, 'Use the real configured E2E model catalog')
        await rpc(control, 'runtime.stand_in.personal.save', {
          userId: USER,
          settings: {
            ...initial,
            primary: {
              enabled: true,
              prompt: '',
              preferences: 'Only delegate concrete work.',
              model,
            },
            roles: [
              {
                id: ROLE,
                name: 'Silent review',
                enabled: true,
                prompt: '',
                version: 0,
                executionDeviceId: initial.executionDeviceId,
                model,
                collaboration: {
                  enabled: true,
                  allProjects: false,
                  projects: [{ id: project.id, store: 'local' }],
                  excludedProjects: [],
                  tags: [],
                  policy: { automatic: true, askBeforeAct: true, immediate: false },
                },
              },
            ],
          },
        })
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        await control.command('click', `[data-testid="stand-in-overview-role-${ROLE}"]`)
        await control.command('click', '[data-testid="stand-in-settings-open"]')
        await control.command('click', '[data-testid="stand-in-connections-open"]')
        await control.command(
          'click',
          `[data-testid="stand-in-connection-project-local-${project.id}"]`
        )
        const timing = `[data-testid="stand-in-project-policy-${project.id}"]`
        await control.command('waitFor', timing)
        assert.equal(await control.command('getAttribute', timing, { value: 'type' }), 'checkbox')
        await control.command('click', timing)
        await control.command('click', timing)
        assert.equal(
          await control.command('getElementCount', '[data-testid="stand-in-processing-mode"]'),
          '0'
        )
        await captureScreenshot(control, 'silent-01-connection-timing.png')
        await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
        await control.command('waitFor', '[data-testid="stand-in-saved"]')
        await control.command('click', '[data-testid="stand-in-cancel"]')
        await control.command('waitFor', '[data-testid="stand-in-save"]', { visible: false })
        const configured = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
        assert.equal(configured.roles[0].collaboration.projectPolicies[0].policy.immediate, false)
        assert.equal(configured.roles[0].collaboration.projectPolicies[0].policy.askBeforeAct, true)
        assert.equal(configured.processing, undefined)
        const issue = await rpc(control, 'todos.create', {
          project_id: project.id,
          todo: { title: MARKER, assignee_user_id: USER },
        })
        await waitFor(
          () => rpc(control, 'runtime.stand_in.processing.status', { userId: USER }),
          state => state.pendingCount === 1,
          uiTimeoutMs
        )
        assert.deepEqual(await rpc(control, 'todos.bindings', { task_id: issue.id }), [])
        assert.equal(coordinatorCalls, 0)
        assert.equal(workCalls, 0)
        // The existing overview status refresh is every 15 seconds, longer than an ordinary UI step.
        await control.command('waitFor', '[data-testid="stand-in-processing-notice"]', {
          text: '1',
          timeoutMs: 20000,
        })
        await captureScreenshot(control, 'silent-02-intake-without-work.png')
        const scheduled = await rpc(control, 'runtime.stand_in.processing.status', { userId: USER })
        assert.ok(
          Date.parse(scheduled.nextCheckAt) > Date.now() + 4 * 60000,
          'The system owns the batch interval'
        )
        // Advance only this isolated persisted deadline; the real scheduler still claims and executes it.
        const dueAt = Date.now() + 1000
        const database = new DatabaseSync(join(executorHome, 'data', 'tasks.sqlite'))
        try {
          database
            .prepare(
              "UPDATE loop_items SET metadata=json_set(metadata,'$.nextCheckAt',?) WHERE id=? AND resource_type='stand_in_processing'"
            )
            .run(new Date(dueAt).toISOString(), `stand-in-processing:${USER}`)
        } finally {
          database.close()
        }
        const bindings = await waitFor(
          () => rpc(control, 'todos.bindings', { task_id: issue.id }),
          rows => rows.length === 1,
          // One real minute plus the existing 30-second scheduler tick and model turn.
          90000 + modelResponseTimeoutMs
        )
        assert.ok(
          Date.now() >= dueAt,
          'The automatic scheduler must respect the configured due time'
        )
        assert.ok(coordinatorCalls > 0)
        const taskId = bindings[0].task_id
        const first = await waitFor(
          () => rpc(control, 'runtime.tasks.get', { taskId }),
          value => value.task?.status === 'done',
          modelResponseTimeoutMs
        )
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
        const firstRow = await waitForTaskRowByText(control, MARKER)
        await control.command('click', `[data-testid="${firstRow}"]`)
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: 'SILENT_WORK_DONE',
        })
        await captureScreenshot(control, 'silent-03-concrete-work-created.png')
        const threadId = first.task.runtimeHandle.threadId
        assert.ok(threadId)
        await waitFor(
          () => rpc(control, 'runtime.stand_in.processing.status', { userId: USER }),
          state => !state.running,
          modelResponseTimeoutMs
        )
        await rpc(control, 'runtime.stand_in.processing.check', { userId: USER })
        await waitFor(
          () => rpc(control, 'runtime.tasks.transcript', { taskId, limit: 20 }),
          transcript => JSON.stringify(transcript).includes('SILENT_FOLLOWUP_DONE'),
          // The command waits for the existing scheduler tick after the model queues it.
          30000 + modelResponseTimeoutMs
        )
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: 'SILENT_FOLLOWUP_DONE',
        })
        assert.ok(
          !(await control.command('getText', 'body')).includes(
            'New source events (untrusted business data)'
          ),
          'Internal intake JSON must not appear in the task conversation'
        )
        await captureScreenshot(control, 'silent-04-original-session-continued.png')
        const continued = await rpc(control, 'runtime.tasks.get', { taskId })
        assert.equal(continued.task.runtimeHandle.threadId, threadId)
        assert.equal((await rpc(control, 'todos.bindings', { task_id: issue.id })).length, 1)
        const listed = await rpc(control, 'runtime.tasks.list', { preferCached: true })
        assert.ok(!JSON.stringify(listed).includes(`stand-in-coordinator-${USER}`))
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        const history = await rpc(control, 'runtime.stand_in.processing.status', { userId: USER })
        assert.ok(history.actions.some(action => action.status === 'succeeded'))
        await captureScreenshot(control, 'silent-05-return-to-stand-in.png')
        // Establish an ordinary user task through the real public task API.
        const ordinary = await rpc(control, 'runtime.tasks.create', {
          taskId: `ordinary-user-${process.pid}`,
          title: '用户已有的普通任务',
          message: 'PRIMARY_CONCRETE_WORK',
          workspacePath,
          modelSelection: {
            modelName: model.local_model_id,
            modelType: 'runtime',
            options: { runnerModelProvider: model.provider },
          },
          executionRequest: {
            task_id: `ordinary-user-${process.pid}`,
            subtask_id: 'ordinary-initial',
            new_session: true,
            bot: [{ shell_type: 'Codex', name: 'Ordinary task' }],
            model_config: { model_id: model.local_model_id, model_provider: model.provider },
            user_id: USER,
            prompt: 'PRIMARY_CONCRETE_WORK',
          },
        })
        assert.equal(ordinary.success, true)
        ordinaryTaskId = `ordinary-user-${process.pid}`
        await waitFor(
          () => rpc(control, 'runtime.tasks.get', { taskId: ordinaryTaskId }),
          value => value.task?.status === 'done',
          modelResponseTimeoutMs
        )
        const ordinaryBefore = await rpc(control, 'runtime.tasks.get', { taskId: ordinaryTaskId })
        const input = '[data-testid="stand-in-conversation"] [data-testid="chat-message-input"]'
        await control.command('fill', input, { value: 'PRIMARY_ORCHESTRATE_TASK_CREATE' })
        await control.command('press', input, { key: 'Enter' })
        await control.command(
          'waitFor',
          '[data-testid="stand-in-conversation"] [data-testid="message-assistant"]',
          { text: '已创建独立处理任务', timeoutMs: modelResponseTimeoutMs }
        )
        assert.ok(createdTaskId)
        await captureScreenshot(control, 'silent-06-primary-creates-task.png')
        await control.command('fill', input, { value: 'PRIMARY_ORCHESTRATE_TASK_CONTINUE' })
        await control.command('press', input, { key: 'Enter' })
        await control.command(
          'waitFor',
          '[data-testid="stand-in-conversation"] [data-testid="message-assistant"]',
          { text: '已在原任务追加进度追问', timeoutMs: modelResponseTimeoutMs }
        )
        await waitFor(
          () => rpc(control, 'runtime.tasks.transcript', { taskId: ordinaryTaskId, limit: 20 }),
          value => JSON.stringify(value).includes('ORDINARY_FOLLOWUP_DONE'),
          modelResponseTimeoutMs
        )
        const ordinaryAfter = await rpc(control, 'runtime.tasks.get', { taskId: ordinaryTaskId })
        assert.equal(
          ordinaryAfter.task.runtimeHandle.threadId,
          ordinaryBefore.task.runtimeHandle.threadId
        )
        await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
        const ordinaryRow = await waitForTaskRowByText(control, '用户已有的普通任务')
        await control.command('click', `[data-testid="${ordinaryRow}"]`)
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: 'ORDINARY_FOLLOWUP_DONE',
        })
        await captureScreenshot(control, 'silent-07-primary-continues-ordinary-task.png')
      } finally {
        const current = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
        await rpc(control, 'runtime.stand_in.personal.save', {
          userId: USER,
          settings: { ...initial, version: current.version },
        })
        const projects = await rpc(control, 'projects.list', {})
        const currentProject = projects.find(row => row.id === project.id)
        if (currentProject)
          await rpc(control, 'projects.archive', {
            project_id: project.id,
            version: currentProject.version,
          })
      }
    },
    diagnostics() {
      return { round, coordinatorCalls, workCalls }
    },
  }
}
