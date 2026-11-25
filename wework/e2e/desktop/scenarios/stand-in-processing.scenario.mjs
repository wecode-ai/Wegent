import {
  openStandInSettings,
  openStandInActivity,
} from '../modules/stand-in-profile-navigation.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { waitForTaskRowByText } from '../modules/task-state-flows.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { isDetachedResponsesContext } from '../modules/model-tool-output.mjs'
import { createMeetingUserStory } from '../modules/stand-in-meeting-user-story.mjs'
import {
  ONBOARDING_FIRST_MESSAGE,
  ONBOARDING_FOLLOWUP,
} from './stand-in-onboarding-skip.scenario.mjs'
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
const BACKGROUND_PERMISSION_PROBE = 'BACKGROUND_PERMISSION_PROBE'
const BACKGROUND_PERMISSION_DONE = 'BACKGROUND_PERMISSION_DONE'
const BACKGROUND_CONTINUE_CALL = 'background-continue-owner-task'
const FULL_ACCESS = { permissionMode: 'full-access' }

function assertNativeThreadPermission(log, threadId, profile) {
  const applied = log
    .split('\n')
    .filter(
      line =>
        line.includes('codex source sandbox applied ') && line.includes(` thread_id=${threadId} `)
    )
  assert.ok(
    applied.some(
      line =>
        line.includes(String.raw`\"id\":\"${profile}\"`) &&
        line.includes(String.raw`reviewer="\"user\""`)
    ),
    `Native Codex thread ${threadId} must apply ${profile} with the human reviewer. Observed: ${applied.join('\n') || 'no application'}`
  )
}

function processingInput(body) {
  const input = Array.isArray(body.input) ? body.input : [body.input]
  return input.filter(item => {
    if (isDetachedResponsesContext(item)) return false
    if (
      item?.type === 'function_call_output' &&
      item.namespace === 'agent' &&
      item.name === 'weworkstandinrecall'
    )
      return false
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
}

export function createDesktopScenario({
  captureScreenshot,
  workspacePath,
  executorHome,
  resultDir,
  uiTimeoutMs,
  modelResponseTimeoutMs,
}) {
  let round = 1
  let coordinatorCalls = 0
  let workCalls = 0
  let ordinaryTaskId
  let createdTaskId
  let originalRoleTaskId
  let checkBackgroundPermission = false
  let backgroundContinueAccepted = false
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
      const messages = processingInput(body)
      const input = JSON.stringify(messages)
      const latestUserInput = JSON.stringify(
        messages.findLast(item => item?.role === 'user')?.content ?? []
      )
      let events = delegatedTaskResultEvents(body)
      if (events) {
        // A result wake is a new host turn, even when its history quotes the original request.
      } else if (latestUserInput.includes(ONBOARDING_FIRST_MESSAGE)) {
        events = [assistantMessage(`${ONBOARDING_FIRST_MESSAGE}_ANSWERED`)]
      } else if (latestUserInput.includes(ONBOARDING_FOLLOWUP)) {
        events = [assistantMessage(`${ONBOARDING_FOLLOWUP}_ANSWERED`)]
      } else if (
        checkBackgroundPermission &&
        latestUserInput.includes('Review this silent intake batch')
      ) {
        if (requestContainsToolOutput(body, BACKGROUND_CONTINUE_CALL)) {
          const result = JSON.parse(readMcpToolOutput(body, BACKGROUND_CONTINUE_CALL))
          assert.equal(result.accepted, true, 'The real coordinator must enqueue this follow-up')
          assert.equal(result.taskId, createdTaskId)
          backgroundContinueAccepted = true
          events = [assistantMessage('已安排后台续办。')]
        } else {
          events = mcpToolRequestEvents(body, {
            toolName: 'continue_task',
            directToolName: 'mcp__wework_stand_in__continue_task',
            argumentsValue: {
              taskId: createdTaskId,
              requestId: BACKGROUND_CONTINUE_CALL,
              message: BACKGROUND_PERMISSION_PROBE,
            },
            searchCallId: `${BACKGROUND_CONTINUE_CALL}-search`,
            toolCallId: BACKGROUND_CONTINUE_CALL,
          }).events
        }
      } else if (latestUserInput.includes(BACKGROUND_PERMISSION_PROBE)) {
        events = [assistantMessage(BACKGROUND_PERMISSION_DONE)]
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
          const taskId = intake.works.find(work => work.taskId === originalRoleTaskId)?.taskId
          assert.ok(taskId, 'The review batch must expose the original work conversation')
          assert.ok(intake.events.every(event => event.kind === 'assignment'))
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
      } else if (latestUserInput.includes('PRIMARY_ORCHESTRATE_TASK')) {
        const followup = latestUserInput.includes('PRIMARY_ORCHESTRATE_TASK_CONTINUE')
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
                  title: '主助理安排的具体工作',
                  message: 'PRIMARY_CONCRETE_WORK',
                },
            searchCallId: `${callId}-search`,
            toolCallId: callId,
          }).events
        }
      } else if (
        latestUserInput.includes('PRIMARY_CONCRETE_WORK') ||
        latestUserInput.includes('ORDINARY_PROGRESS_CHECK')
      ) {
        events = [
          assistantMessage(
            latestUserInput.includes('ORDINARY_PROGRESS_CHECK')
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
              taskPermissions: FULL_ACCESS,
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
        // Successful direct work must leave coordination idle.
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
        originalRoleTaskId = taskId
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
        const discovery = await rpc(control, 'runtime.coordination.contexts', {})
        assert.equal(
          discovery.contexts.find(context => context.id === `personal:${USER}`)?.needsProcessing,
          false,
          'Successful role work must leave coordination idle'
        )
        assert.equal(
          await control.command('getElementCount', '[data-testid="stand-in-processing-notice"]'),
          '0',
          'Successful role work must not open a processing notice'
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
        const settings = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
        settings.roles[0].collaboration.projectPolicies[0].policy.immediate = false
        await rpc(control, 'runtime.stand_in.personal.save', { userId: USER, settings })
        const reviewIssue = await rpc(control, 'todos.create', {
          project_id: project.id,
          todo: { title: 'Check progress on the original assignment', assignee_user_id: USER },
        })
        await waitFor(
          () => rpc(control, 'runtime.stand_in.processing.status', { userId: USER }),
          state => state.pendingCount > 0 && Date.parse(state.nextCheckAt) > Date.now() + 4 * 60000,
          uiTimeoutMs
        )
        // Advance this isolated source's receive window, never a removed global coordinator deadline.
        let dueAt
        const database = new DatabaseSync(join(executorHome, 'data', 'tasks.sqlite'))
        try {
          database.exec('PRAGMA busy_timeout = 10000')
          const assignmentWhere =
            "resource_type='stand_in_event' AND json_extract(metadata,'$.userId')=? AND json_extract(metadata,'$.issueId')=? AND json_extract(metadata,'$.kind')='assignment' AND json_extract(metadata,'$.status')='pending'"
          const assignment = database.prepare(
            `SELECT COUNT(*) AS count FROM loop_items WHERE ${assignmentWhere}`
          )
          await waitFor(
            () => assignment.get(USER, reviewIssue.id).count,
            count => count === 1,
            uiTimeoutMs
          )
          database.exec('BEGIN IMMEDIATE')
          dueAt = Date.now() + 1000
          const changed = database
            .prepare(
              `UPDATE loop_items SET metadata=json_set(metadata,'$.createdAt',?) WHERE ${assignmentWhere}`
            )
            .run(new Date(dueAt - 5 * 60000).toISOString(), USER, reviewIssue.id)
          assert.equal(changed.changes, 1, 'The real review assignment must be pending')
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
        const ownerTask = await waitFor(
          () => rpc(control, 'runtime.tasks.get', { taskId: createdTaskId }),
          value => value.task?.status === 'done',
          modelResponseTimeoutMs
        )
        assert.deepEqual(ownerTask.task.runtimeHandle.taskPermissions, FULL_ACCESS)
        const ownerThreadId = ownerTask.task.runtimeHandle.threadId
        assert.ok(ownerThreadId)
        const executorLog = join(resultDir, 'executor.log')
        const ownerLog = await readFile(executorLog, 'utf8')
        assertNativeThreadPermission(ownerLog, ownerThreadId, ':danger-full-access')

        checkBackgroundPermission = true
        const permissionReview = await rpc(control, 'todos.create', {
          project_id: project.id,
          todo: { title: 'Review the owner task permissions', assignee_user_id: USER },
        })
        await waitFor(
          () => rpc(control, 'runtime.stand_in.processing.status', { userId: USER }),
          state => state.pendingCount > 0,
          uiTimeoutMs
        )
        const scheduledBackground = await rpc(control, 'runtime.coordination.wake', {
          contextId: `personal:${USER}`,
        })
        assert.equal(scheduledBackground.accepted, true)
        await waitFor(
          () => rpc(control, 'runtime.tasks.transcript', { taskId: createdTaskId, limit: 20 }),
          transcript =>
            backgroundContinueAccepted &&
            transcript.messages?.some(
              message =>
                message.role === 'assistant' &&
                message.content?.includes(BACKGROUND_PERMISSION_DONE)
            ),
          modelResponseTimeoutMs
        )
        checkBackgroundPermission = false
        const review = await rpc(control, 'todos.get', {
          project_id: project.id,
          task_id: permissionReview.id,
        })
        await rpc(control, 'todos.update', {
          project_id: project.id,
          task_id: permissionReview.id,
          todo: { version: review.version, status: 'completed', assignee_user_id: null },
        })
        const backgroundTask = await rpc(control, 'runtime.tasks.get', { taskId: createdTaskId })
        assert.equal(backgroundTask.task.runtimeHandle.threadId, ownerThreadId)
        assert.deepEqual(backgroundTask.task.runtimeHandle.taskPermissions, FULL_ACCESS)
        assertNativeThreadPermission(
          (await readFile(executorLog, 'utf8')).slice(ownerLog.length),
          ownerThreadId,
          'wework-source-read'
        )
        const afterPermissionProbe = await rpc(control, 'runtime.stand_in.personal.get', {
          userId: USER,
        })
        await rpc(control, 'runtime.stand_in.personal.save', {
          userId: USER,
          settings: {
            ...afterPermissionProbe,
            primary: {
              ...afterPermissionProbe.primary,
              taskPermissions: initial.primary?.taskPermissions,
            },
          },
        })
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
