import {
  openStandInSettings,
  openStandInActivity,
} from '../modules/stand-in-profile-navigation.mjs'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { waitForTaskRowByText } from '../modules/task-state-flows.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { createMeetingUserStory } from '../modules/stand-in-meeting-user-story.mjs'
import {
  assistantMessage,
  createSse,
  delegatedTaskResultEvents,
  handleModelMaintenanceRequest,
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

function processingInput(body) {
  const input = Array.isArray(body.input) ? body.input : [body.input]
  return JSON.stringify(
    input.filter(item => {
      const text =
        typeof item?.content === 'string'
          ? item.content
          : (item?.content ?? []).map(part => part?.text ?? '').join('')
      // Quoted recall remains in the real request, but cannot select a scripted command.
      return !(
        item?.role === 'user' &&
        text.trim().startsWith('<external_wework.stand-in.recall>') &&
        text.trim().endsWith('</external_wework.stand-in.recall>')
      )
    })
  )
}

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
  const meetingStory = createMeetingUserStory({
    rpc,
    executorHome,
    workspacePath,
    modelResponseTimeoutMs,
    captureScreenshot,
  })
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
  async function verifyQueuedAssignmentReceipt(control, projectId) {
    const issue = await rpc(control, 'todos.create', {
      project_id: projectId,
      todo: { title: 'Queued assignment reception', assignee_user_id: USER },
    })
    try {
      const receipts = await waitFor(
        () =>
          rpc(control, 'todos.assignment_receipts', { project_id: projectId, task_id: issue.id }),
        rows => rows.length === 1 && rows[0].stand_in_received_at,
        uiTimeoutMs
      )
      assert.equal(receipts[0].human_read_at, null)
      const bindings = await rpc(control, 'todos.bindings', { task_id: issue.id })
      assert.equal(bindings.length, 1, 'Receipt retains recipient-owned task authority')
      const task = await rpc(control, 'runtime.tasks.get', { taskId: bindings[0].task_id })
      assert.equal(
        task.code,
        'task_not_found',
        'Background intake acknowledges before starting a model'
      )
      assert.equal(workCalls, 0)
      assert.equal(coordinatorCalls, 0)
    } finally {
      const latest = await rpc(control, 'todos.get', { project_id: projectId, task_id: issue.id })
      await rpc(control, 'todos.update', {
        project_id: projectId,
        task_id: issue.id,
        todo: { version: latest.version, status: 'completed', assignee_user_id: null },
      })
      await rpc(control, 'todos.archive', { project_id: projectId, task_id: issue.id })
    }
  }
  return {
    async handleHttp(req, response, url) {
      if (await meetingStory.handleHttp(req, response, url)) return true
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (isReplyPredictionRequest(body)) return false
      const input = processingInput(body)
      let events = delegatedTaskResultEvents(body)
      if (events) {
        // A result wake is a new host turn, even when its history quotes the original request.
      } else if (input.includes('Review this silent intake batch')) {
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
          assert.ok(taskId, 'The feedback batch must expose the original work conversation')
          assert.ok(intake.events.every(event => ['work_state', 'followup'].includes(event.kind)))
          events = mcpToolRequestEvents(body, {
            toolName: 'continue_work',
            directToolName: 'mcp__wework_stand_in__continue_work',
            argumentsValue: { eventIds, taskId, message: FOLLOWUP },
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
        await control.command('seedLocalProject', 'body', {
          value: JSON.stringify({
            projectKey: 'silent-ordinary-workspace',
            name: '已有工作的代码项目',
            path: workspacePath,
          }),
        })
        const workspace = {
          projectKey: 'silent-ordinary-workspace',
          workspacePath,
          executionMode: 'current_workspace',
        }
        await rpc(control, 'runtime.stand_in.personal.save', {
          userId: USER,
          settings: {
            ...initial,
            primary: {
              enabled: true,
              prompt: '',
              preferences: 'Only delegate concrete work.',
              model,
              workspace,
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
                workspace,
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
        await control.command('clickWhenEnabled', `[data-testid="stand-in-overview-role-${ROLE}"]`)
        await openStandInSettings(control)
        await control.command('clickWhenEnabled', '[data-testid="stand-in-connections-open"]')
        await control.command(
          'click',
          `[data-testid="stand-in-connection-project-local-${project.id}"]`
        )
        const timing = `[data-testid="stand-in-project-policy-${project.id}"]`
        await control.command(
          'clickWhenEnabled',
          '[data-testid="stand-in-processing-settings-toggle"]'
        )
        await control.command('waitFor', timing)
        assert.equal(await control.command('getAttribute', timing, { value: 'type' }), 'button')
        assert.equal(await control.command('getAttribute', timing, { value: 'role' }), 'switch')
        assert.equal(
          await control.command('getAttribute', timing, { value: 'aria-checked' }),
          'false'
        )
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
        await verifyQueuedAssignmentReceipt(control, project.id)
        // Direct source routing is explicit; completion feedback still uses the silent window.
        await openStandInSettings(control)
        await control.command('clickWhenEnabled', '[data-testid="stand-in-connections-open"]')
        await control.command(
          'click',
          `[data-testid="stand-in-connection-project-local-${project.id}"]`
        )
        await control.command(
          'clickWhenEnabled',
          '[data-testid="stand-in-processing-settings-toggle"]'
        )
        await control.command('click', timing)
        assert.equal(
          await control.command('getAttribute', timing, { value: 'aria-checked' }),
          'true'
        )
        await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
        await control.command('waitFor', '[data-testid="stand-in-saved"]')
        await control.command('click', '[data-testid="stand-in-cancel"]')
        await control.command('waitFor', '[data-testid="stand-in-save"]', { visible: false })
        const issue = await rpc(control, 'todos.create', {
          project_id: project.id,
          todo: { title: MARKER, assignee_user_id: USER },
        })
        const bindings = await waitFor(
          () => rpc(control, 'todos.bindings', { task_id: issue.id }),
          rows => rows.length === 1,
          90000 + modelResponseTimeoutMs
        )
        const taskId = bindings[0].task_id
        const first = await waitFor(
          () => rpc(control, 'runtime.tasks.get', { taskId }),
          value => value.task?.status === 'done',
          modelResponseTimeoutMs
        )
        assert.equal(workCalls, 1, 'An explicit assignment starts its one eligible role directly')
        assert.equal(
          coordinatorCalls,
          0,
          'Direct assignment must not require an extra model assessment'
        )
        const scheduled = await waitFor(
          () => rpc(control, 'runtime.stand_in.processing.status', { userId: USER }),
          state => state.pendingCount > 0 && Date.parse(state.nextCheckAt) > Date.now() + 4 * 60000,
          uiTimeoutMs
        )
        assert.equal(scheduled.running, false)
        assert.equal(
          await control.command('getElementCount', '[data-testid="stand-in-processing-notice"]'),
          '0',
          'Scheduled background feedback without a question or failure must not interrupt the user'
        )
        await captureScreenshot(control, 'silent-02-feedback-without-extra-work.png')
        // Collaboration executions belong to the stand-in work list, not the ordinary task sidebar.
        const workCard = `[data-testid="stand-in-activity-task-${taskId}"]`
        await openStandInActivity(control)
        await control.command('waitFor', workCard)
        await control.command('click', workCard)
        await control.command('click', '[data-testid="stand-in-preview-open"]')
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: 'SILENT_WORK_DONE',
        })
        await captureScreenshot(control, 'silent-03-concrete-work-created.png')
        const threadId = first.task.runtimeHandle.threadId
        assert.ok(threadId)
        // Advance this isolated source's receive window, never a removed global coordinator deadline.
        let dueAt
        const database = new DatabaseSync(join(executorHome, 'data', 'tasks.sqlite'))
        try {
          database.exec('PRAGMA busy_timeout = 10000')
          // Completion precedes the coordinator's observation tick. Other intake
          // can satisfy pendingCount, so wait for this task's durable completion.
          const feedbackWhere =
            "resource_type='stand_in_event' AND json_extract(metadata,'$.userId')=? AND json_extract(metadata,'$.taskId')=? AND json_extract(metadata,'$.kind')='work_state' AND json_extract(metadata,'$.status')='pending' AND json_extract(metadata,'$.state[3]')='done'"
          const feedback = database.prepare(
            `SELECT COUNT(*) AS count FROM loop_items WHERE ${feedbackWhere}`
          )
          await waitFor(
            () => feedback.get(USER, taskId).count,
            count => count > 0,
            uiTimeoutMs
          )
          database.exec('BEGIN IMMEDIATE')
          dueAt = Date.now() + 1000
          const changed = database
            .prepare(
              `UPDATE loop_items SET metadata=json_set(metadata,'$.createdAt',?) WHERE ${feedbackWhere}`
            )
            .run(new Date(dueAt - 5 * 60000).toISOString(), USER, taskId)
          assert.ok(changed.changes > 0, 'The real completed work must produce durable feedback')
          database.exec('COMMIT')
        } finally {
          database.close()
        }
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
        assert.ok(Date.now() >= dueAt, 'The source receive window must expire before assessment')
        assert.ok(coordinatorCalls > 0)
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
        await control.command('waitFor', '[data-testid="stand-in-details-open"]:not(:disabled)')
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
        await meetingStory.verify(control, model)
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
