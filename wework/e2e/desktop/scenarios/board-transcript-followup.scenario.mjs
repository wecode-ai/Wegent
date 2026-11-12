import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import {
  codexRequestKind,
  createSse,
  handleEmptyReplyPrediction,
  latestModelInputText,
  readRequestBody,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PANE = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER = `${PANE} [data-testid="chat-message-input"][contenteditable="true"]`
const MESSAGES = `${PANE} [data-testid="desktop-chat-scroll"]`
const TASK_CHAT = '[data-testid="ai-chat-modal"]'
const TASK_MESSAGES = `${TASK_CHAT} [data-testid="work-item-task-chat-panel"]`
const INITIAL = 'BOARD_TRANSCRIPT_INITIAL'
const FOLLOWUP = 'BOARD_TRANSCRIPT_FOLLOWUP'
const PARTIAL = 'BOARD_TRANSCRIPT_VISIBLE_BEFORE_COMPLETION'
const COMPLETE = `${PARTIAL}\nBOARD_TRANSCRIPT_COMPLETE`

/** Delay delivery of a real idle transcript while a real native turn streams. */
export function createDesktopScenario({
  workspacePath,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  resultDir,
}) {
  let releaseModel
  const heldModel = new Promise(resolve => {
    releaseModel = resolve
  })
  let followupRequests = 0

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
      const kind = codexRequestKind(body)
      const followup =
        kind !== 'prewarm' && kind !== 'compaction' && latestModelInputText(body).includes(FOLLOWUP)
      const text = followup ? COMPLETE : `${INITIAL}_COMPLETE`
      const events = streamingTextEvents(`board-transcript-${Date.now()}`, text, 'final_answer')
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.write(createSse(events.start))
      if (followup) {
        followupRequests += 1
        response.write(
          createSse([
            {
              type: 'response.output_text.delta',
              item_id: events.itemId,
              output_index: 0,
              content_index: 0,
              delta: PARTIAL,
              offset: 0,
            },
          ])
        )
        await heldModel
        response.write(
          createSse([
            {
              type: 'response.output_text.delta',
              item_id: events.itemId,
              output_index: 0,
              content_index: 0,
              delta: text.slice(PARTIAL.length),
              offset: PARTIAL.length,
            },
          ])
        )
      } else {
        response.write(
          createSse([
            {
              type: 'response.output_text.delta',
              item_id: events.itemId,
              output_index: 0,
              content_index: 0,
              delta: text,
              offset: 0,
            },
          ])
        )
      }
      response.end(createSse(events.finish))
      return true
    },
    async verify(control) {
      const gates = runtimeTransportGates(control)
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      await createSingleRootLocalProject(control, workspacePath, 'Board transcript regression')
      await selectE2EModel(control, 'local-model:desktop-e2e-responses', 'Desktop E2E Responses')
      await control.command('fill', COMPOSER, { value: INITIAL })
      await control.command('clickWhenEnabled', `${PANE} [data-testid="send-message-button"]`)
      await control.command('waitFor', MESSAGES, {
        text: `${INITIAL}_COMPLETE`,
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', `${PANE} [data-testid="pause-response-button"]`, {
        visible: false,
      })
      const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot'))
      const address = debug.workbench.currentRuntimeTask
      assert.ok(address?.taskId, 'The initial native task must exist')
      const project = { id: 'default-work-items' }
      const issue = await rpc('todos.create', {
        project_id: project.id,
        todo: { title: 'Review the completed task', status: 'in_review' },
      })
      const binding = await rpc('todos.bind', {
        project_id: project.id,
        item_id: issue.id,
        task: { deviceId: address.deviceId, taskId: address.taskId },
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('navigate', 'body', { value: '/todo?projectId=default-work-items' })
      await control.command('waitFor', `${CONTENT} [data-testid="cloud-todo-card-${issue.id}"]`)
      // Keep the card mounted in one column when the follow-up changes its status.
      await control.command('click', `${CONTENT} [data-testid="cloud-board-group-by"]`)
      await control.command('click', '[data-testid="cloud-board-group-option-priority"]')
      // Remount after arming the gate so an earlier preload cannot satisfy it.
      await control.command('fill', `${CONTENT} [data-testid="cloud-board-search"]`, {
        value: 'hide-all-cards',
      })
      await control.command('waitFor', `${CONTENT} [data-testid="cloud-todo-card-${issue.id}"]`, {
        visible: false,
      })
      try {
        await gates.arm({
          id: 'idle-board-transcript',
          kind: 'response',
          name: 'runtime.tasks.transcript',
          holdFollowing: true,
          where: [
            { path: 'params.limit', equals: 20 },
            { path: 'params.includeFullContent', equals: true },
            { path: 'params.projectSession.issueId', equals: issue.id },
          ],
        })
        await control.command('fill', `${CONTENT} [data-testid="cloud-board-search"]`, {
          value: '',
        })
        await control.command('waitFor', `${CONTENT} [data-testid="cloud-todo-card-${issue.id}"]`)
        const hold = await gates.wait('idle-board-transcript')
        assert.equal(hold.value.result.running, false, 'The held board transcript must be idle')
        assert.equal(hold.value.result.fullContent, true, 'The held board transcript must be full')
        await control.command(
          'click',
          `${CONTENT} [data-testid="cloud-todo-card-open-task-${issue.id}"]`
        )
        const openConversation = `${CONTENT} [data-testid="cloud-todo-open-task-conversation-${binding.id}"]`
        await control.command('waitFor', openConversation)
        await control.command('click', openConversation)
        await control.command('waitFor', TASK_CHAT)
        await control.command(
          'fill',
          `${TASK_CHAT} [data-testid="chat-message-input"][contenteditable="true"]`,
          { value: FOLLOWUP }
        )
        await control.command(
          'clickWhenEnabled',
          `${TASK_CHAT} [data-testid="send-message-button"]`
        )
        await control.command('waitFor', TASK_MESSAGES, {
          text: PARTIAL,
          timeoutMs: modelResponseTimeoutMs,
        })
        assert.equal(followupRequests, 1, 'The follow-up must still be held by the model')
        await gates.save(resultDir, 'idle-board-transcript-held.json', ['idle-board-transcript'])
        await gates.release('idle-board-transcript')
        await gates.save(resultDir, 'idle-board-transcript-delivered.json', [
          'idle-board-transcript',
        ])
        // Assert every observation: an eventual reappearance must not hide a retraction.
        const deadline = Date.now() + 500
        do {
          const text = await control.command('getRuntimeConversationMessages', 'body', {
            value: JSON.stringify(address),
          })
          assert.ok(text.includes(FOLLOWUP), 'The idle board read retracted the user follow-up')
          assert.ok(text.includes(PARTIAL), 'The idle board read retracted the streaming reply')
          assert.ok(!text.includes('BOARD_TRANSCRIPT_COMPLETE'), 'The model completed too early')
          const visible = await control.command('getText', TASK_MESSAGES)
          assert.ok(visible.includes(FOLLOWUP), 'The visible follow-up disappeared')
          assert.ok(visible.includes(PARTIAL), 'The visible streaming reply disappeared')
          await new Promise(resolve => setTimeout(resolve, 25))
        } while (Date.now() < deadline)
        assert.ok((await control.command('getText', TASK_MESSAGES)).includes(PARTIAL))
        await gates.reset()
        releaseModel()
        await control.command('waitFor', TASK_MESSAGES, { text: 'BOARD_TRANSCRIPT_COMPLETE' })
        await control.command('click', '[data-testid="ai-chat-modal-close"]')
        await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
        await control.command('waitFor', `${PANE} [data-testid="pause-response-button"]`, {
          visible: false,
        })
        await reloadMainWindow(control)
        await control.command('waitFor', MESSAGES, { text: 'BOARD_TRANSCRIPT_COMPLETE' })
        assert.ok((await control.command('getText', MESSAGES)).includes(FOLLOWUP))
      } finally {
        releaseModel()
        await gates.reset()
      }
    },
    cleanup: () => releaseModel(),
  }
}
