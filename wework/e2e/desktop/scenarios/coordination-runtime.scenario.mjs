import assert from 'node:assert/strict'
import { openStandInDetails } from '../modules/stand-in-profile-navigation.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
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
const ROLE = 'router-owner'
const MARKER = 'COORDINATION_RUNTIME_NATIVE_WORK'
// The status panel polls every 15 seconds; allow one poll plus UI settlement.
const PROCESSING_NOTICE_TIMEOUT_MS = 20_000

/** Real Core DSH -> Executor -> Codex. Only the model's HTTP responses are scripted. */
export function createDesktopScenario({
  captureScreenshot,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  workspacePath,
}) {
  let assessments = 0
  let workTurns = 0
  let failAssessment = true
  let failedRequests = 0
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  async function until(load, ready, label) {
    const deadline = Date.now() + uiTimeoutMs + modelResponseTimeoutMs
    let latest
    while (Date.now() < deadline) {
      latest = await load()
      if (ready(latest)) return latest
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail(`${label}: ${JSON.stringify(latest)}`)
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
        assessments++
        if (failAssessment) {
          failedRequests++
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              error: { type: 'invalid_request_error', message: 'E2E_COORDINATION_FAILURE' },
            })
          )
          return true
        }
        if (requestContainsToolOutput(body, 'router-ignore')) {
          assert.equal(JSON.parse(readMcpToolOutput(body, 'router-ignore')).status, 'pending')
          events = [assistantMessage('已记录进展，无需重复创建工作。')]
        } else if (requestContainsToolOutput(body, 'router-intake')) {
          const intake = JSON.parse(readMcpToolOutput(body, 'router-intake')).snapshot
          assert.ok(intake.events.length > 0)
          assert.ok(intake.events.every(event => event.kind === 'work_state'))
          assert.equal(intake.works.length, 1)
          events = mcpToolRequestEvents(body, {
            toolName: 'ignore_events',
            directToolName: 'mcp__wework_stand_in__ignore_events',
            argumentsValue: {
              eventIds: intake.events.map(event => event.id),
              reason: 'The work completed; no extra execution is needed.',
            },
            searchCallId: 'router-ignore-search',
            toolCallId: 'router-ignore',
          }).events
        } else {
          events = mcpToolRequestEvents(body, {
            toolName: 'read_intake',
            directToolName: 'mcp__wework_stand_in__read_intake',
            argumentsValue: {},
            searchCallId: 'router-intake-search',
            toolCallId: 'router-intake',
          }).events
        }
      } else if (input.includes(MARKER)) {
        workTurns++
        events = [assistantMessage('ROUTER_NATIVE_WORK_COMPLETED')]
      } else return false
      const id = `router-model-${assessments}-${workTurns}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const initial = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
      const project = await rpc(control, 'projects.create', { name: `Router ${process.pid}` })
      try {
        const catalog = await rpc(control, 'runtime.runner.catalog', {})
        const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
        assert.ok(model, 'Use the real configured model catalog')
        await control.command('seedLocalProject', 'body', {
          value: JSON.stringify({
            projectKey: 'coordination-runtime-workspace',
            name: 'Router isolated workspace',
            path: workspacePath,
          }),
        })
        const workspace = {
          projectKey: 'coordination-runtime-workspace',
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
              preferences: 'Avoid duplicate work.',
              model,
              workspace,
            },
            roles: [
              {
                id: ROLE,
                name: 'Router owner',
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
                  policy: { automatic: true, askBeforeAct: true, immediate: true },
                },
              },
            ],
          },
        })
        // Establish observation before the new execution, rather than waking for historical work.
        await until(
          () => rpc(control, 'runtime.stand_in.processing.status', { userId: USER }),
          state => Number.isInteger(state.observedSince),
          'The real coordination plugin must start observing'
        )
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        await control.command('clickWhenEnabled', `[data-testid="stand-in-overview-role-${ROLE}"]`)
        await control.command('waitFor', '[data-testid="stand-in-details-open"]:not(:disabled)')
        await captureScreenshot(control, 'router-01-existing-stand-in-entry.png')
        const issue = await rpc(control, 'todos.create', {
          project_id: project.id,
          todo: { title: MARKER, assignee_user_id: USER },
        })
        const bindings = await until(
          () => rpc(control, 'todos.bindings', { task_id: issue.id }),
          rows => rows.length === 1,
          'A direct handoff must create exactly one execution'
        )
        const taskId = bindings[0].task_id
        await until(
          () => rpc(control, 'runtime.tasks.get', { taskId }),
          value => value.task?.status === 'done',
          'The real native work must complete'
        )
        assert.equal(workTurns, 1)
        assert.equal(assessments, 0, 'One eligible role requires no coordination model call')
        await control.command('waitFor', `[data-testid="stand-in-activity-task-${taskId}"]`)
        await captureScreenshot(control, 'router-02-one-concrete-work.png')
        const pending = await until(
          () => rpc(control, 'runtime.stand_in.processing.status', { userId: USER }),
          state => state.pendingCount > 0 && Date.parse(state.nextCheckAt) > Date.now() + 240000,
          'Ordinary execution feedback must enter its fixed silent window'
        )
        assert.equal(pending.running, false)
        assert.equal(assessments, 0)
        assert.equal(
          await control.command('getElementCount', '[data-testid="stand-in-processing-notice"]'),
          '0',
          'Routine background feedback without a question or failure must remain silent'
        )
        await captureScreenshot(control, 'router-03-feedback-silent-intake.png')
        await rpc(control, 'runtime.stand_in.processing.check', { userId: USER })
        const failed = await until(
          () => rpc(control, 'runtime.stand_in.processing.status', { userId: USER }),
          state => state.error?.code === 'coordination_stopped',
          'A definitive model failure must stop automatic reassessment'
        )
        const failedAction = failed.actions.find(action => action.kind === 'assess')
        assert.ok(failedAction)
        assert.ok(failed.pendingCount > 0)
        assert.ok(failedRequests > 0)
        const failedReceipt = await rpc(control, 'runtime.tasks.commands.get', {
          taskId: failed.taskId,
          commandId: failedAction.id,
          userId: USER,
        })
        assert.equal(failedReceipt.state, 'failed')
        await openStandInDetails(control)
        await control.command('clickWhenEnabled', '[data-testid="stand-in-status-open"]')
        await control.command('waitFor', '[data-testid="stand-in-status-dialog"]')
        await control.command('waitFor', '[data-testid="stand-in-processing-check"]', {
          timeoutMs: PROCESSING_NOTICE_TIMEOUT_MS,
        })
        await control.command('waitFor', '[data-testid="stand-in-processing-open-task"]')
        await captureScreenshot(control, 'router-04-assessment-failure-recovery-entry.png')
        failAssessment = false
        await control.command('click', '[data-testid="stand-in-processing-check"]')
        const settled = await until(
          () => rpc(control, 'runtime.stand_in.processing.status', { userId: USER }),
          state =>
            state.pendingCount === 0 &&
            !state.running &&
            state.actions.some(
              action => action.kind === 'ignore_events' && action.status === 'succeeded'
            ),
          'Native MCP intents must finish without creating duplicate work'
        )
        assert.equal(settled.error, null)
        assert.ok(assessments > 0)
        assert.equal(workTurns, 1)
        assert.equal(
          (
            await rpc(control, 'runtime.tasks.commands.get', {
              taskId: failed.taskId,
              commandId: failedAction.id,
              userId: USER,
            })
          ).state,
          'failed',
          'Explicit recovery must not replay the old failed command'
        )
        assert.ok(
          settled.actions.some(
            action =>
              action.kind === 'assess' &&
              action.id !== failedAction.id &&
              action.status === 'succeeded'
          )
        )
        const recoveredAction = settled.actions.find(
          action =>
            action.kind === 'assess' &&
            action.id !== failedAction.id &&
            action.status === 'succeeded'
        )
        const recoveredReceipt = await rpc(control, 'runtime.tasks.commands.get', {
          taskId: settled.taskId,
          commandId: recoveredAction.id,
          userId: USER,
        })
        assert.ok(failedReceipt.native?.[1])
        assert.equal(
          recoveredReceipt.native?.[1],
          failedReceipt.native[1],
          'Explicit recovery must resume the original coordinator thread with fresh MCP grants'
        )
        await control.command('waitFor', '[data-testid="stand-in-processing-check"]', {
          visible: false,
          timeoutMs: PROCESSING_NOTICE_TIMEOUT_MS,
        })
        await control.command('click', '[data-testid="stand-in-status-dialog-close"]')
        await captureScreenshot(control, 'router-05-explicit-recovery-completed.png')
        assert.equal((await rpc(control, 'todos.bindings', { task_id: issue.id })).length, 1)
        const listed = await rpc(control, 'runtime.tasks.list', { preferCached: true })
        assert.ok(!JSON.stringify(listed).includes(`stand-in-coordinator-${USER}`))
        await control.command('click', `[data-testid="stand-in-activity-task-${taskId}"]`)
        await control.command('click', '[data-testid="stand-in-preview-open"]')
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: 'ROUTER_NATIVE_WORK_COMPLETED',
        })
        await captureScreenshot(control, 'router-06-original-work-remains-authoritative.png')
        return { taskId, workTurns, assessments, failedRequests }
      } finally {
        const current = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
        await rpc(control, 'runtime.stand_in.personal.save', {
          userId: USER,
          settings: { ...initial, version: current.version },
        })
      }
    },
  }
}
