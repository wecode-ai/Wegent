import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
const RELEASE = '.wework-e2e-release-late-command'
const CALL = 'late-command-result'
const COMPLETION_GATE = 'late-command-completion'
const TRANSCRIPT_GATE = 'late-command-transcript'

export function createStreamingCommandCancellationChecks({
  workspacePath,
  resultDir,
  uiTimeoutMs,
}) {
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
        const command = `while [ ! -f './${RELEASE}' ]; do sleep 0.05; done; printf '%s' '${OUTPUT}'`
        const tool = selectShellTool(body, workspacePath, command)
        response.end(
          sse([responseCreated(id), ...selectedToolCall(CALL, tool), responseCompleted(id)])
        )
      }
      return true
    },
    async verify(control) {
      const gates = runtimeTransportGates(control)
      const release = join(workspacePath, RELEASE)
      await rm(release, { force: true })
      try {
        await openNewChatWithE2EModel(control, uiTimeoutMs)
        await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
        await control.command(
          'clickWhenEnabled',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        const address = await waitForValue(
          async () => {
            const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
            return debug.workbench.currentRuntimeTask
          },
          value => Boolean(value?.taskId),
          'The command regression task did not open',
          10_000
        )
        const matches = block => block.toolInput?.command?.includes(OUTPUT)
        const read = async () => {
          const messages = JSON.parse(
            await control.command('getRuntimeConversationMessages', 'body', {
              value: JSON.stringify(address),
            })
          )
          const message = messages.find(message => message.blocks?.some(matches))
          return {
            turnId: message?.turnId,
            status: message?.runtimeStatus,
            block: message?.blocks.find(matches),
          }
        }
        const running = await waitForValue(
          read,
          value => value.block?.renderPayload?.status === 'inProgress',
          'The command did not appear running before its release file was written',
          10_000
        )
        await gates.arm({
          id: COMPLETION_GATE,
          kind: 'event',
          name: 'response.block.updated',
          where: [
            { path: 'payload.taskId', equals: address.taskId },
            { path: 'payload.data.block_id', equals: running.block.id },
            { path: 'payload.data.updates.status', equals: 'done' },
          ],
        })
        await gates.arm({
          id: TRANSCRIPT_GATE,
          kind: 'response',
          name: 'runtime.tasks.transcript',
          where: [{ path: 'params.taskId', equals: address.taskId }],
          holdFollowing: true,
        })
        // History can already contain the result while its live event is held.
        await writeFile(release, '')
        const completion = await gates.wait(COMPLETION_GATE)
        assert.equal(completion.value.payload.subtaskId, running.turnId)
        assert.equal(completion.value.payload.data.updates.render_payload.exitCode, 0)
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
        await gates.save(resultDir, 'streaming-command-cancellation-transport.json', [
          COMPLETION_GATE,
          TRANSCRIPT_GATE,
        ])
        await gates.reset()
        await rm(release, { force: true })
      }
    },
  }
}
