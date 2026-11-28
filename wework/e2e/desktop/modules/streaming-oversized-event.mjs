import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { createModelResponseGates } from './model-response-gates.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'
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

const SEED_PROMPT = 'WEWORK_OVERSIZED_EVENT_SEED'
const PROMPT = 'WEWORK_OVERSIZED_EVENT_CONTINUATION'
const SEED_REPLY = 'Conversation ready for another turn.'
const PROGRESS = 'Streaming after the oversized start event.'
const FINAL = 'Completed after the oversized terminal event.'
const SEND = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`

export function createOversizedEventChecks({ resultDir, uiTimeoutMs }) {
  const modelGates = createModelResponseGates()
  const start = modelGates.pause()
  const finish = modelGates.pause()

  return {
    cleanup: modelGates.cleanup,
    async handleModelRequest(body, response, id) {
      const text = latestModelInputText(body)
      if (!text.includes(SEED_PROMPT) && !text.includes(PROMPT)) return false
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      if (text.includes(SEED_PROMPT)) {
        const reply = streamingEvents(id, SEED_REPLY, 'final_answer')
        response.end(
          sse([...reply.start, ...textDeltaEvents(reply.itemId, SEED_REPLY), ...reply.finish])
        )
        return true
      }

      const progress = streamingEvents(`${id}-progress`, PROGRESS, 'commentary')
      const answer = streamingEvents(`${id}-answer`, FINAL, 'final_answer', 1)
      response.flushHeaders()
      await start.promise
      response.write(sse([...progress.start, ...textDeltaEvents(progress.itemId, PROGRESS)]))
      await finish.promise
      response.end(
        sse([
          ...progress.finish.filter(event => event.type !== 'response.completed'),
          ...answer.start.filter(event => event.type !== 'response.created'),
          ...textDeltaEvents(answer.itemId, FINAL, 0, 1),
          ...answer.finish.filter(event => event.type !== 'response.completed'),
          responseCompleted(id, [progress.finish.at(-2).item, answer.finish.at(-2).item]),
        ])
      )
      return true
    },
    async verify(control) {
      const gates = runtimeTransportGates(control)
      const boundaries = [
        ['oversized-start', 'response.created'],
        ['oversized-completion', 'response.completed'],
      ]
      const readyCount = control.readyCount
      try {
        await openNewChatWithE2EModel(control, uiTimeoutMs)
        await control.command('fill', COMPOSER_SELECTOR, { value: SEED_PROMPT })
        await control.command('clickWhenEnabled', SEND)
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: SEED_REPLY })
        await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
        const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        const { deviceId, taskId } = debug.workbench.currentRuntimeTask
        const address = { deviceId, taskId }
        // A real persisted title puts the lifecycle envelopes over the executor's 256 KiB limit.
        const rename = await requestExecutor(
          control,
          'runtime.tasks.rename',
          { address, title: 'Oversized conversation title '.repeat(10_000) },
          uiTimeoutMs
        )
        assert.equal(rename.accepted, true, 'The executor rejected the oversized title fixture')
        for (const [id, originalEvent] of boundaries) {
          await gates.arm({
            id,
            kind: 'event',
            name: 'executor.event_lagged',
            hold: false,
            where: [
              { path: 'payload.taskId', equals: taskId },
              { path: 'payload.reason', equals: 'event_too_large' },
              { path: 'payload.originalEvent', equals: originalEvent },
            ],
          })
        }

        await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
        await control.command('clickWhenEnabled', SEND)
        await gates.wait('oversized-start')
        start.resolve()
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"]`,
          {
            text: PROGRESS,
          }
        )
        finish.resolve()
        await gates.wait('oversized-completion')
        await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: FINAL })
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]:has([data-testid="final-processing-toggle"]) [data-testid="processing-duration-label"]`
        )
        assert.equal(control.readyCount, readyCount, 'The conversation required a renderer reload')
      } finally {
        modelGates.cleanup()
        await gates.save(
          resultDir,
          'oversized-stream-transport.json',
          boundaries.map(([id]) => id)
        )
        await gates.reset()
      }
    },
  }
}
