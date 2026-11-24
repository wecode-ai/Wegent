import assert from 'node:assert/strict'
import { selectedToolCall } from './model-tool-calls.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  COMPOSER_SELECTOR,
  latestModelInputText,
  openNewChatWithE2EModel,
  requestContainsToolOutputForCall,
  responseCompleted,
  responseCreated,
  selectShellTool,
  sse,
} from './streaming-text-fixture.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

const PROMPT = 'WEWORK_CANCEL_WITH_COMMAND_RESULT_IN_FLIGHT'
const OUTPUT = 'WEWORK_LATE_COMMAND_RESULT'
const CALL = 'late-command-result'
const COMPLETION_GATE = 'late-command-completion'
const TRANSCRIPT_GATE = 'late-command-transcript'

export function createStreamingCommandCancellationChecks({ workspacePath, uiTimeoutMs }) {
  const held = new Set()
  return {
    cleanup() {
      for (const response of held) response.end()
    },
    handleModelRequest(body, response, id) {
      const commandFinished = requestContainsToolOutputForCall(body, CALL)
      if (!commandFinished && !latestModelInputText(body).includes(PROMPT)) return false
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      if (commandFinished) {
        held.add(response)
        response.once('close', () => held.delete(response))
        response.write(sse([responseCreated(id)]))
      } else {
        const tool = selectShellTool(body, workspacePath, `printf '%s' '${OUTPUT}'`)
        response.end(
          sse([responseCreated(id), ...selectedToolCall(CALL, tool), responseCompleted(id)])
        )
      }
      return true
    },
    async verify(control) {
      const gates = runtimeTransportGates(control)
      try {
        await openNewChatWithE2EModel(control, uiTimeoutMs)
        await gates.arm({
          id: COMPLETION_GATE,
          kind: 'event',
          name: 'response.block.updated',
          where: [
            { path: 'payload.data.updates.status', equals: 'done' },
            { path: 'payload.data.updates.render_payload.kind', equals: 'command_execution' },
          ],
        })
        await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
        await control.command(
          'clickWhenEnabled',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        const completion = await gates.wait(COMPLETION_GATE)
        const { taskId, subtaskId, data } = completion.value.payload
        assert.ok(
          data.block.tool_input.command.includes(OUTPUT),
          'Gate captured a different command'
        )
        const { workbench } = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        const address = workbench.currentRuntimeTask
        assert.equal(address.taskId, taskId)
        const read = async () => {
          const messages = JSON.parse(
            await control.command('getRuntimeConversationMessages', 'body', {
              value: JSON.stringify(address),
            })
          )
          const message = messages.find(
            message =>
              message.turnId === subtaskId &&
              message.blocks?.some(block => block.id === data.block_id)
          )
          return {
            status: message?.runtimeStatus,
            block: message?.blocks.find(block => block.id === data.block_id),
          }
        }
        await waitForValue(
          read,
          value => value.block?.renderPayload?.status === 'inProgress',
          'The command did not appear running before its result was delivered',
          10_000
        )
        await gates.arm({
          id: TRANSCRIPT_GATE,
          kind: 'response',
          name: 'runtime.tasks.transcript',
          where: [{ path: 'params.taskId', equals: taskId }],
          holdFollowing: true,
        })
        await control.command(
          'clickWhenEnabled',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`
        )
        await waitForValue(
          read,
          value =>
            value.status === 'cancelled' && value.block?.renderPayload?.status === 'inProgress',
          'The stopped turn did not retain the command while its result was held',
          10_000
        )
        await gates.release(COMPLETION_GATE)
        await waitForValue(
          read,
          value =>
            value.status === 'cancelled' &&
            value.block?.status === 'done' &&
            value.block.renderPayload?.status === 'completed',
          'The real command result did not close the running tool in the stopped conversation',
          10_000
        )
      } finally {
        await gates.reset()
      }
    },
  }
}
