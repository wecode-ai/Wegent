import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  ASSISTANT_CONTENT_SELECTOR,
  COMPOSER_SELECTOR,
  assistantMessage,
  latestModelInputText,
  openNewChatWithE2EModel,
  responseCompleted,
  responseCreated,
  sse,
  streamingEvents,
  textDeltaEvents,
  waitForRuntimePaneReadyToSend,
} from './streaming-text-fixture.mjs'

const PROMPT = 'WEWORK_STREAMING_TRANSCRIPT_IDENTITY'
const WARMUP = 'STREAM_IDENTITY_WARMUP'
const READY = 'STREAM_IDENTITY_READY'
const PROGRESS = 'STREAM_IDENTITY_PROGRESS: inspecting the implementation.'
const PREFIX = 'STREAM_IDENTITY_PREFIX: first part of the reply.\n\n'
const SUFFIX = 'STREAM_IDENTITY_SUFFIX: second part of the same reply.'
const COMPLETE = PREFIX + SUFFIX

export function createStreamingTranscriptIdentityChecks({ uiTimeoutMs }) {
  let releaseSuffix
  let releaseCompletion
  const suffixReleased = new Promise(resolve => {
    releaseSuffix = resolve
  })
  const completionReleased = new Promise(resolve => {
    releaseCompletion = resolve
  })

  async function assertReply(control, row, expected) {
    const content = `${row} [data-testid="assistant-message-content"]`
    const paragraphs = expected.trim().split('\n\n')
    await control.command('waitFor', content, { text: paragraphs.at(-1) })
    assert.equal(Number(await control.command('getElementCount', content)), 1)
    assert.equal(
      Number(await control.command('getElementCount', `${content} p`)),
      paragraphs.length
    )
    assert.equal(await control.command('getText', `${content} p`), paragraphs.join('\n'))
    const narrative = `${row} [data-testid="process-text-block"]`
    await control.command('waitFor', narrative, { text: PROGRESS })
    const [process] = JSON.parse(await control.command('getElementMetrics', narrative))
    const [reply] = JSON.parse(await control.command('getElementMetrics', content))
    assert.ok(process && reply && process.bottom <= reply.top, 'Process text moved into the reply')
  }

  return {
    async handleModelRequest(body, response, id) {
      const input = latestModelInputText(body)
      if (input.includes(WARMUP)) {
        const reply = assistantMessage(READY, 'final_answer')
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(sse([responseCreated(id), reply, responseCompleted(id, [reply.item])]))
        return true
      }
      if (!input.includes(PROMPT)) return false
      const progress = streamingEvents(`${id}-progress`, PROGRESS, 'commentary')
      const final = streamingEvents(`${id}-final`, COMPLETE, 'final_answer', 1)
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.flushHeaders()
      response.write(
        sse([
          responseCreated(id),
          ...progress.start.filter(event => event.type !== 'response.created'),
          ...textDeltaEvents(progress.itemId, PROGRESS),
          ...progress.finish.filter(event => event.type !== 'response.completed'),
          ...final.start.filter(event => event.type !== 'response.created'),
          ...textDeltaEvents(final.itemId, PREFIX, 0, 1),
        ])
      )
      await suffixReleased
      response.write(sse(textDeltaEvents(final.itemId, SUFFIX, PREFIX.length, 1)))
      await completionReleased
      response.end(
        sse([
          ...final.finish.filter(event => event.type !== 'response.completed'),
          responseCompleted(
            id,
            [progress, final].map(
              stream => stream.finish.find(event => event.type === 'response.output_item.done').item
            )
          ),
        ])
      )
      return true
    },

    async verify(control) {
      try {
        await openNewChatWithE2EModel(control, uiTimeoutMs)
        await control.command('fill', COMPOSER_SELECTOR, { value: WARMUP })
        await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: READY })
        await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
        await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
        await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: PREFIX.trim() })
        const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        const address = debug.workbench?.currentRuntimeTask
        assert.ok(address?.taskId, 'The running reply has no runtime task address')
        // Establish native pagination, then exercise the running cache used on task restoration.
        await requestExecutor(
          control,
          'runtime.tasks.transcript',
          { address, refresh: true },
          uiTimeoutMs
        )
        const cached = await requestExecutor(
          control,
          'runtime.tasks.transcript',
          { address },
          uiTimeoutMs
        )
        const turn = cached.turns.at(-1)
        const row = `${ACTIVE_WORKBENCH_SELECTOR} [data-message-id=${JSON.stringify(`runtime-view:${turn.id}:assistant`)}]`
        const nativeMessage = cached.messages.findLast(
          message => message.turnId === turn.id && message.role === 'assistant'
        )
        assert.equal(cached.running, true)
        assert.deepEqual(
          turn.items.filter(item => item.type !== 'user_message'),
          nativeMessage.runtimeItems,
          'The running cache changed native identities or order'
        )
        assert.equal(turn.items.findLast(item => item.type === 'assistant_text').content, PREFIX)

        const readyCount = control.readyCount
        await control.command('reloadMainWindow', 'body')
        await control.awaitReadyAfter(readyCount)
        await assertReply(control, row, PREFIX)
        const snapshot = JSON.parse(await control.command('snapshot', row))
        assert.equal(
          snapshot.text.split(PREFIX.trim()).length - 1,
          1,
          'Restoration duplicated the prefix'
        )
        releaseSuffix()
        await assertReply(control, row, COMPLETE)
        const growing = JSON.parse(await control.command('snapshot', row))
        assert.equal(growing.text.split(PREFIX.trim()).length - 1, 1)
        assert.equal(growing.text.split(PROGRESS).length - 1, 1)
        releaseCompletion()
        await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
        await control.command('waitFor', `${row} [data-testid="assistant-message-content"]`, {
          text: SUFFIX,
        })
      } finally {
        releaseSuffix()
        releaseCompletion()
      }
    },
  }
}
