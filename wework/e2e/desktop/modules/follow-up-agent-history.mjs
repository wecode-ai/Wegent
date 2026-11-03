import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isCollaborationSubagentRequest } from './subagent-request.mjs'
import {
  assistantMessage,
  createSse,
  namespacedFunctionCall,
  responseCreated,
  responseCompleted,
  customToolCall,
  selectProgrammaticExec,
  toolOutputText,
} from './response-protocol.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'

const INITIAL = 'WeworkReusedAgentHistory'
const FOLLOW_UP = 'WeworkReusedAgentFollowUp'
const CHILD = 'follow_up_history_child'

// A child thread is reused in two real native turns. Its activity id must never
// join those turns when a latest page no longer contains the earlier turn.
export function followUpAgentHistory(options, activeSelector, heldExecutionProgram) {
  let spawned = false
  let resumed = false
  let pending = false
  let namespace
  let initialWait = false
  let resumeWait = false
  const startedFile = join(options.workspacePath, 'reused-agent-command-started')
  const releaseFile = join(options.workspacePath, 'reused-agent-command-release')
  const reply = (response, id, events) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
  }
  return {
    async handle(request, body, response) {
      if (isCollaborationSubagentRequest(request.headers)) {
        reply(response, `child-${Date.now()}`, [assistantMessage('Child work completed')])
        return true
      }
      const content = JSON.stringify(body)
      if (!content.includes(INITIAL)) return false
      if (!spawned) {
        const candidates = (body.tools ?? []).filter(
          tool =>
            tool.type === 'namespace' && tool.tools?.some(nested => nested.name === 'spawn_agent')
        )
        assert.equal(
          candidates.length,
          1,
          'The native request must advertise one collaboration namespace'
        )
        namespace = candidates[0].name
        spawned = true
        reply(
          response,
          'history-spawn',
          namespacedFunctionCall('history-spawn', namespace, 'spawn_agent', {
            task_name: CHILD,
            message: 'Complete this isolated regression fixture.',
          })
        )
      } else if (!content.includes(FOLLOW_UP) && !initialWait) {
        initialWait = true
        reply(
          response,
          'history-initial-wait',
          namespacedFunctionCall('history-initial-wait', namespace, 'wait_agent', {
            timeout_ms: 60_000,
          })
        )
      } else if (!content.includes(FOLLOW_UP)) {
        reply(response, 'history-result', [assistantMessage(`${INITIAL} completed result`)])
      } else if (!resumed) {
        resumed = true
        reply(response, 'history-resume', [
          ...Array.from({ length: 520 }, (_, index) => {
            const item = assistantMessage(`Current execution progress ${index}`)
            item.output_index = index
            item.item.id = `current-history-${index}`
            item.item.phase = 'commentary'
            return item
          }),
          ...namespacedFunctionCall('history-resume', namespace, 'followup_task', {
            target: CHILD,
            message: 'Complete another isolated regression fixture.',
          }).map(event => ({ ...event, output_index: 520 })),
        ])
      } else if (!resumeWait) {
        resumeWait = true
        reply(
          response,
          'history-resumed-wait',
          namespacedFunctionCall('history-resumed-wait', namespace, 'wait_agent', {
            timeout_ms: 60_000,
          })
        )
      } else if (!pending) {
        pending = true
        const tool = selectProgrammaticExec(
          body,
          heldExecutionProgram(options.workspacePath, startedFile, releaseFile, FOLLOW_UP)
        )
        const call = customToolCall('history-held-command', tool.name, tool.input)
        call.item.namespace = 'functions'
        reply(response, 'history-live', [call])
      } else {
        assert.ok(
          existsSync(startedFile),
          `The real command failed: ${toolOutputText(body, 'history-held-command')}`
        )
        reply(response, 'history-final', [assistantMessage('Regression work completed')])
      }
      return true
    },
    async verify(control, otherAddress) {
      const send = async text => {
        const composer = `${activeSelector} [data-testid="chat-message-input"][contenteditable="true"]`
        await control.command('fill', composer, { value: text })
        await control.command('waitFor', `${activeSelector} [data-testid="send-message-button"]`, {
          enabled: true,
        })
        await control.command('press', composer, { key: 'Enter' })
      }
      const assistant = `${activeSelector} [data-testid="message-assistant"]`
      try {
        await control.command('click', '[data-testid="new-chat-button"]')
        await send(INITIAL)
        const initial = await waitForWorkbenchDebugState(
          control,
          state =>
            state.pane?.messageSummary?.lastMessage?.role === 'assistant' &&
            state.pane?.messageSummary?.lastMessage?.status === 'done' &&
            state.pane?.subagentStatuses?.some(agent => agent.status === 'done'),
          'The first native turn and its child agent must finish'
        )
        const address = initial.workbench.currentRuntimeTask
        const originalId = await control.command('getAttribute', assistant, {
          text: `${INITIAL} completed result`,
          value: 'data-message-id',
        })
        await send(FOLLOW_UP)
        await waitForWorkbenchDebugState(
          control,
          () => existsSync(startedFile),
          'The resumed child and the real parent command must run before switching'
        )
        await control.command(
          'click',
          `[data-testid="runtime-local-task-row-${otherAddress.taskId}"]`
        )
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await waitForWorkbenchDebugState(
          control,
          state =>
            state.workbench?.currentRuntimeTask?.taskId === address.taskId &&
            !state.pane?.transcript?.loading &&
            state.pane?.transcript?.hasMoreBefore,
          'The running turn must load a native page that excludes the older turn'
        )
        assert.equal(
          await control.command('getAttribute', assistant, {
            text: `${INITIAL} completed result`,
            value: 'data-message-id',
          }),
          originalId,
          'A reused child thread must not move old output into the current turn'
        )
      } finally {
        await writeFile(releaseFile, 'release')
      }
      await waitForWorkbenchDebugState(
        control,
        state => !state.pane?.status?.isBusy,
        'The parent command must finish after releasing the regression assertion'
      )
    },
  }
}
