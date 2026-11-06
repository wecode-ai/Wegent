import { selectedToolCall } from './model-tool-calls.mjs'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isCollaborationSubagentRequest } from './subagent-request.mjs'
import {
  assistantMessage,
  createSse,
  selectTool,
  responseCreated,
  responseCompleted,
  customToolCall,
  selectProgrammaticExec,
  toolOutputText,
} from './response-protocol.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

const INITIAL = 'WeworkReusedAgentHistory'
const FOLLOW_UP = 'WeworkReusedAgentFollowUp'
const CHILD = 'follow_up_history_child'

// A child thread is reused in two real native turns. Its activity id must never
// join those turns when a latest page no longer contains the earlier turn.
export function followUpAgentHistory(options, activeSelector, heldExecutionProgram) {
  let spawned = false
  let resumed = false
  let pending = false
  let initialReady = false
  let resumedReady = false
  let statusCallId
  let statusSequence = 0
  let statusDeadline
  const startedFile = join(options.workspacePath, 'reused-agent-command-started')
  const releaseFile = join(options.workspacePath, 'reused-agent-command-release')
  const reply = (response, id, events) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
  }
  const childReady = (body, response) => {
    const output = statusCallId && toolOutputText(body, statusCallId)
    if (output) {
      const child = JSON.parse(output).agents.find(agent => agent.agent_name === `/root/${CHILD}`)
      if (child?.agent_status && Object.hasOwn(child.agent_status, 'completed')) {
        statusCallId = undefined
        statusDeadline = undefined
        return true
      }
    }
    statusDeadline ??= Date.now() + options.uiTimeoutMs
    assert.ok(
      Date.now() < statusDeadline,
      'The real child agent must finish before parent execution'
    )
    statusCallId = `history-child-status-${++statusSequence}`
    reply(
      response,
      statusCallId,
      selectedToolCall(
        statusCallId,
        selectTool(body, 'list_agents', { path_prefix: `/root/${CHILD}` })
      )
    )
    return false
  }
  return {
    diagnostics: () => ({ spawned, resumed, pending, initialReady, resumedReady, statusSequence }),
    async handle(request, body, response) {
      if (isCollaborationSubagentRequest(request.headers)) {
        reply(response, `child-${Date.now()}`, [assistantMessage('Child work completed')])
        return true
      }
      const content = JSON.stringify(body)
      if (!content.includes(INITIAL)) return false
      if (spawned && !content.includes(FOLLOW_UP) && !initialReady) {
        if (!childReady(body, response)) return true
        initialReady = true
      }
      if (resumed && !resumedReady) {
        if (!childReady(body, response)) return true
        resumedReady = true
      }
      if (!spawned) {
        spawned = true
        reply(
          response,
          'history-spawn',
          selectedToolCall(
            'history-spawn',
            selectTool(body, 'spawn_agent', {
              task_name: CHILD,
              message: 'Complete this isolated regression fixture.',
            })
          )
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
          ...selectedToolCall(
            'history-resume',
            selectTool(body, 'followup_task', {
              target: CHILD,
              message: 'Complete another isolated regression fixture.',
            })
          ).map(event => ({ ...event, output_index: 520 })),
        ])
      } else if (!pending) {
        pending = true
        const tool = selectProgrammaticExec(
          body,
          heldExecutionProgram(options.workspacePath, startedFile, releaseFile, FOLLOW_UP)
        )
        const call = customToolCall('history-held-command', tool.name, tool.input)
        if (tool.namespace) call.item.namespace = tool.namespace
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
        // Native history preparation uses the runner's model-response budget.
        // The command-start check begins only once Codex requests that command.
        await waitForValue(
          () => pending,
          requested => requested,
          'Native history preparation must reach the parent command request',
          options.modelResponseTimeoutMs
        )
        await waitForValue(
          () => existsSync(startedFile),
          started => started,
          'The resumed child and the real parent command must run before switching',
          options.uiTimeoutMs
        )
        await control.command(
          'click',
          `[data-testid="runtime-local-task-row-${otherAddress.taskId}"]`
        )
        await waitForWorkbenchDebugState(
          control,
          state => state.workbench?.currentRuntimeTask?.taskId === otherAddress.taskId,
          'The other task must become active before returning'
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
