import assert from 'node:assert/strict'
import { createModelResponseGates } from './model-response-gates.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  ASSISTANT_CONTENT_SELECTOR,
  COMPOSER_SELECTOR,
  latestModelInputText,
  openNewChatWithE2EModel,
  responseCompleted,
  sse,
  streamingEvents,
  textDeltaEvents,
  waitForRuntimePaneReadyToSend,
} from './streaming-text-fixture.mjs'

const PROMPT = 'WEWORK_STREAMING_POSITIONED_COMPLETION'
const PREFIX = '我继续核对🙂实际创建路径，不把已'
const SUFFIX = '发现的缺陷直接当作本次根因。'
const COMPLETE = PREFIX + SUFFIX
const FINAL = 'POSITIONED_COMPLETION_FINISHED'
const PROCESS = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"]`
const GATE = 'positioned-commentary-tail'

export function createStreamingCompletionChecks({ resultDir, uiTimeoutMs }) {
  const modelGates = createModelResponseGates()
  const tail = modelGates.pause()
  const commentary = modelGates.pause()
  const final = modelGates.pause()
  const cleanup = modelGates.cleanup
  return {
    cleanup,
    async handleModelRequest(body, response, id) {
      if (!latestModelInputText(body).includes(PROMPT)) return false
      const progress = streamingEvents(`${id}-progress`, COMPLETE, 'commentary')
      const answer = streamingEvents(`${id}-answer`, FINAL, 'final_answer', 1)
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.flushHeaders()
      response.write(sse([...progress.start, ...textDeltaEvents(progress.itemId, PREFIX)]))
      await tail.promise
      response.write(sse(textDeltaEvents(progress.itemId, SUFFIX, Array.from(PREFIX).length)))
      await commentary.promise
      response.write(
        sse([
          ...progress.finish.filter(event => event.type !== 'response.completed'),
          ...answer.start.filter(event => event.type !== 'response.created'),
          ...textDeltaEvents(answer.itemId, FINAL, 0, 1),
        ])
      )
      await final.promise
      response.end(
        sse([
          ...answer.finish.filter(event => event.type !== 'response.completed'),
          responseCompleted(id, [progress.finish.at(-2).item, answer.finish.at(-2).item]),
        ])
      )
      return true
    },
    async verify(control) {
      const gates = runtimeTransportGates(control)
      try {
        await openNewChatWithE2EModel(control, uiTimeoutMs)
        await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
        await control.command(
          'clickWhenEnabled',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        await control.command('waitFor', PROCESS, { text: PREFIX })
        const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        const address = debug.workbench.currentRuntimeTask
        assert.ok(address?.taskId, 'The streaming commentary has no task address')
        // Hold an actual event after persistence, then restore the real native history.
        await gates.arm({
          id: GATE,
          kind: 'event',
          name: 'response.block.updated',
          where: [
            { path: 'payload.taskId', equals: address.taskId },
            { path: 'payload.data.updates.content_delta', equals: SUFFIX },
          ],
        })
        tail.resolve()
        await gates.wait(GATE)
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', COMPOSER_SELECTOR)
        await control.command(
          'clickWhenEnabled',
          `[data-testid="runtime-local-task-row-${address.taskId}"]`
        )
        await waitForWorkbenchDebugState(
          control,
          snapshot =>
            snapshot.pane?.currentRuntimeTask?.taskId === address.taskId &&
            snapshot.pane?.transcript?.loading === false,
          'The commentary history did not restore',
          uiTimeoutMs
        )
        await control.command('waitFor', PROCESS, { text: COMPLETE })
        await gates.release(GATE)
        await control.command('waitFor', PROCESS, { text: COMPLETE, stableMs: 300 })
        assert.equal(
          await control.command('getText', `${PROCESS} p`),
          COMPLETE,
          'A delayed delta duplicated the tail already present in native history'
        )
        // Mark only after restoration so subsequent identity checks isolate completion.
        await control.command('markElementWithText', `${PROCESS} p`, {
          text: COMPLETE,
          value: 'completion-paragraph',
        })
        commentary.resolve()
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: FINAL })
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              `${PROCESS} [data-e2e-anchor-id="completion-paragraph"]`
            )
          ),
          1,
          'Completing unchanged commentary replaced its existing Markdown tree'
        )
        final.resolve()
        await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
      } finally {
        await gates.save(resultDir, 'streaming-completion-transport.json', [GATE])
        cleanup()
        await gates.reset()
      }
    },
  }
}
