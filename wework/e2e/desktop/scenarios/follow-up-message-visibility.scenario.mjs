import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import { waitForTranscriptState } from '../modules/transcript-restoration.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  mcpToolRequestEvents,
  requestContainsToolOutput,
  responseCreated,
  responseCompleted,
  readRequestBody,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'

const PANE = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER = `${PANE} [data-testid="chat-message-input"][contenteditable="true"]`
const INITIAL = 'FOLLOW_UP_VISIBILITY_INITIAL'
const FOLLOWUP = 'FOLLOW_UP_VISIBILITY_WHILE_CONTEXT_PENDING'
const GATE = 'follow-up-project-context'
const OLD_DESCRIPTION = 'ISSUE_BODY_BEFORE_FOLLOW_UP'
const LATEST_DESCRIPTION = 'ISSUE_BODY_CHANGED_AFTER_CONTEXT_WAS_LOADED'

/** Hold a background context read: an existing conversation must still send and complete. */
export function createDesktopScenario({
  workspacePath,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  resultDir,
}) {
  let followupRequests = 0
  let completedFollowups = 0
  let issue
  let stage = 0
  return {
    appEnvironment: {
      WEWORK_E2E_CLOUD_BACKEND_URL: '',
      VITE_WEWORK_E2E_CLOUD_BACKEND_URL: '',
      WEWORK_E2E_CLOUD_TOKEN: '',
      VITE_WEWORK_E2E_CLOUD_TOKEN: '',
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const input = JSON.stringify(body)
      if (!input.includes(INITIAL) && !input.includes(FOLLOWUP)) return false
      const followup = input.includes(FOLLOWUP)
      if (followup) {
        if (followupRequests++ === 0) {
          assert.equal(input.includes(OLD_DESCRIPTION), false)
          assert.equal(input.includes(LATEST_DESCRIPTION), false)
          assert.ok(input.includes(issue.id), 'The model needs the bound Issue reference')
        }
        const callId = () => 'follow-up-context-' + stage
        if (requestContainsToolOutput(body, callId())) {
          const value = JSON.parse(readMcpToolOutput(body, callId()))
          if (stage === 1) {
            assert.equal(value.id, issue.id)
            assert.equal(
              value.description,
              LATEST_DESCRIPTION,
              'The source read must see the latest edit'
            )
          }
          stage++
        }
        if (stage < 2) {
          const selection = mcpToolRequestEvents(body, {
            toolName: stage === 0 ? 'get_current_context' : 'get_board_item',
            directToolName:
              stage === 0
                ? 'mcp__wework_space__get_current_context'
                : 'mcp__wework_space__get_board_item',
            argumentsValue:
              stage === 0 ? {} : { space_id: 'default-work-items', item_id: issue.id },
            searchCallId: callId() + '-search',
            toolCallId: callId(),
          })
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          response.end(
            createSse([
              responseCreated('follow-up-context'),
              ...selection.events,
              responseCompleted('follow-up-context'),
            ])
          )
          return true
        }
        completedFollowups++
      }
      const events = streamingTextEvents(
        `follow-up-visibility-${Date.now()}`,
        `${followup ? FOLLOWUP : INITIAL}_COMPLETE`,
        'final_answer'
      )
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([...events.start, ...events.finish]))
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const gates = runtimeTransportGates(control)
      await createSingleRootLocalProject(control, workspacePath, 'follow-up-message-visibility')
      await selectE2EModel(control)
      await control.command('fill', COMPOSER, { value: INITIAL })
      await control.command('clickWhenEnabled', `${PANE} [data-testid="send-message-button"]`)
      await control.command('waitFor', `${PANE} [data-testid="message-assistant"]`, {
        text: `${INITIAL}_COMPLETE`,
        timeoutMs: modelResponseTimeoutMs,
      })
      const idle = await waitForTranscriptState(
        control,
        snapshot => snapshot.pane?.currentRuntimeTask && !snapshot.pane.status.isBusy,
        'The initial conversation did not become idle',
        uiTimeoutMs
      )
      const address = idle.pane.currentRuntimeTask
      issue = await rpc('todos.create', {
        project_id: 'default-work-items',
        todo: { title: 'Follow-up visibility fixture', description: OLD_DESCRIPTION },
      })
      await rpc('todos.bind', {
        project_id: 'default-work-items',
        item_id: issue.id,
        task: { deviceId: address.deviceId, taskId: address.taskId },
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      await control.command('waitFor', `${PANE} [data-testid="work-item-guide-summary-title"]`, {
        text: issue.title,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await gates.arm({
        id: GATE,
        kind: 'response',
        name: 'runtime_tasks.context',
        where: [{ path: 'params.task_id', equals: address.taskId }],
      })
      try {
        await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
        await gates.wait(GATE)
        const currentIssue = await rpc('todos.get', {
          project_id: 'default-work-items',
          task_id: issue.id,
        })
        await rpc('todos.update', {
          project_id: 'default-work-items',
          task_id: issue.id,
          todo: { version: currentIssue.version, description: LATEST_DESCRIPTION },
        })
        await control.command('fill', COMPOSER, { value: FOLLOWUP })
        await control.command('clickWhenEnabled', `${PANE} [data-testid="send-message-button"]`)
        // Read once, without polling through the unrelated context lookup's timeout.
        assert.ok(
          (await control.command('getText', `${PANE} [data-testid="message-user"]`)).includes(
            FOLLOWUP
          ),
          'The follow-up must be visible immediately after clicking Send'
        )
        await control.command('waitFor', `${PANE} [data-testid="message-assistant"]`, {
          text: `${FOLLOWUP}_COMPLETE`,
          timeoutMs: modelResponseTimeoutMs,
        })
        assert.equal(
          (await gates.read(GATE)).deliveries,
          0,
          'The follow-up must complete while the background context read remains pending'
        )
        assert.equal(
          completedFollowups,
          1,
          'The follow-up must complete exactly once after reading the latest source details'
        )
        await gates.save(resultDir, 'follow-up-message-visibility.json', [GATE])
        await gates.release(GATE)
        await control.command('waitFor', `${PANE} [data-testid="message-user"]`, { text: FOLLOWUP })
        assert.equal(
          Number(await control.command('getElementCount', `${PANE} [data-testid="message-user"]`)),
          2,
          'The initial message and accepted follow-up must each appear exactly once'
        )
      } finally {
        await gates.reset()
      }
    },
    diagnostics() {
      return { followupRequests, completedFollowups, stage }
    },
  }
}
