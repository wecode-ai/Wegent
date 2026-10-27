import assert from 'node:assert/strict'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'
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

const PROMPT = 'WEWORK_NATIVE_ORDER_TASK_SWITCH'
const OTHER = 'WEWORK_NATIVE_ORDER_OTHER_TASK'
const PREFIX = 'TASK_SWITCH_RUNNING'
const SUFFIX = '\n\nTASK_SWITCH_BACKGROUND_UPDATE'

export function summarizeSwitchingTranscript(transcript) {
  const turns = transcript.turns ?? []
  const items = turns.flatMap(turn => turn.items)
  const text = items
    .map(item => item.content ?? item.block?.content ?? item.message?.content ?? '')
    .filter(value => typeof value === 'string')
    .join('\n')
  const progress = [...text.matchAll(/TASK_SWITCH_PROGRESS_(\d{3})/g)].map(match =>
    Number(match[1])
  )
  return {
    running: transcript.running,
    turnCount: turns.length,
    turnStatuses: turns.map(turn => turn.status),
    itemCount: items.length,
    positionedItemCount: items.filter(item => Number.isSafeInteger(item.position)).length,
    hasMoreBefore: transcript.hasMoreBefore,
    hasBeforeCursor: Boolean(transcript.beforeCursor),
    progressCount: progress.length,
    firstProgress: progress.length ? Math.min(...progress) : null,
    lastProgress: progress.length ? Math.max(...progress) : null,
    hasPrefix: text.includes(PREFIX),
    hasSuffix: text.includes(SUFFIX.trim()),
  }
}

async function diagnoseSwitchingFailure(control, timeoutMs, stage) {
  console.info('[conversation-switching] verification failed', { stage })
  try {
    const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    const address = debug.workbench?.currentRuntimeTask
    if (!address?.taskId) {
      console.info('[conversation-switching] owner snapshot unavailable', { reason: 'no-task' })
      return
    }
    const startedAt = Date.now()
    const native = await requestExecutor(
      control,
      'runtime.tasks.transcript',
      { address, limit: 5, refresh: true },
      timeoutMs
    )
    console.info('[conversation-switching] owner snapshot after failure', {
      elapsedMs: Date.now() - startedAt,
      ...summarizeSwitchingTranscript(native),
    })
  } catch {
    // Diagnostics must retain the original assertion and never print RPC payloads.
    console.info('[conversation-switching] owner snapshot unavailable', { reason: 'read-failed' })
  }
}

export function createConversationSwitchingChecks({ uiTimeoutMs }) {
  let releaseTail
  let releaseDone
  const tail = new Promise(resolve => {
    releaseTail = resolve
  })
  const done = new Promise(resolve => {
    releaseDone = resolve
  })

  return {
    async handleModelRequest(body, response, id) {
      const input = latestModelInputText(body)
      if (input.includes(OTHER)) {
        const reply = assistantMessage('OTHER_TASK_READY', 'final_answer')
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(sse([responseCreated(id), reply, responseCompleted(id, [reply.item])]))
        return true
      }
      if (!input.includes(PROMPT)) return false
      const output = []
      const events = [responseCreated(id)]
      for (let index = 0; index < 520; index++) {
        const text = `TASK_SWITCH_PROGRESS_${String(index).padStart(3, '0')}`
        const progress = streamingEvents(`${id}-progress-${index}`, text, 'commentary', index)
        events.push(
          ...progress.start.filter(event => event.type !== 'response.created'),
          ...textDeltaEvents(progress.itemId, text, 0, index),
          ...progress.finish.filter(event => event.type !== 'response.completed')
        )
        output.push(progress.finish.find(event => event.type === 'response.output_item.done').item)
      }
      const final = streamingEvents(`${id}-final`, PREFIX + SUFFIX, 'final_answer', 520)
      events.push(
        ...final.start.filter(event => event.type !== 'response.created'),
        ...textDeltaEvents(final.itemId, PREFIX, 0, 520)
      )
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.flushHeaders()
      const startedAt = Date.now()
      const initialEvents = sse(events)
      const writable = response.write(initialEvents)
      console.info('[conversation-switching] initial model events written', {
        progressItems: 520,
        eventCount: events.length,
        bytes: Buffer.byteLength(initialEvents),
        writeElapsedMs: Date.now() - startedAt,
        backpressured: !writable,
      })
      await tail
      console.info('[conversation-switching] background tail released', {
        elapsedMs: Date.now() - startedAt,
      })
      response.write(sse(textDeltaEvents(final.itemId, SUFFIX, PREFIX.length, 520)))
      await done
      output.push(final.finish.find(event => event.type === 'response.output_item.done').item)
      response.end(
        sse([
          ...final.finish.filter(event => event.type !== 'response.completed'),
          responseCompleted(id, output),
        ])
      )
      return true
    },

    async verify(control) {
      let stage = 'initial-prefix'
      try {
        await openNewChatWithE2EModel(control, uiTimeoutMs)
        await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
        await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: PREFIX })
        stage = 'native-history'
        const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        const address = debug.workbench?.currentRuntimeTask
        assert.ok(address?.taskId, 'The long running task has no address')
        const native = await requestExecutor(
          control,
          'runtime.tasks.transcript',
          { address, limit: 5 },
          uiTimeoutMs
        )
        const turn = native.turns.at(-1)
        const persisted = turn.items.filter(item => Number.isSafeInteger(item.position))
        assert.ok(
          persisted.length >= 400,
          'The native fixture did not cross the former item budget'
        )
        assert.ok(native.beforeCursor, 'The long turn did not expose a native history cursor')
        for (let index = 1; index < persisted.length; index++) {
          assert.ok(
            persisted[index - 1].position <= persisted[index].position,
            'Native history is out of order'
          )
        }
        const expectedIds = persisted.map(item => item.id)
        assert.equal(
          new Set(expectedIds).size,
          expectedIds.length,
          'Native history repeated an identity'
        )

        stage = 'other-task'
        await openNewChatWithE2EModel(control, uiTimeoutMs)
        await control.command('fill', COMPOSER_SELECTOR, { value: OTHER })
        await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: 'OTHER_TASK_READY' })
        await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
        releaseTail()
        stage = 'restore-task'
        await control.command(
          'clickWhenEnabled',
          `[data-testid="runtime-local-task-row-${address.taskId}"]`
        )
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: SUFFIX.trim() })
        await waitForWorkbenchDebugState(
          control,
          snapshot =>
            snapshot.pane?.currentRuntimeTask?.taskId === address.taskId &&
            snapshot.pane?.transcript?.loading === false &&
            snapshot.pane?.transcript?.hasMoreBefore === true,
          'The restored native history page did not finish loading'
        )
        const messages = JSON.parse(
          await control.command('getRuntimeConversationMessages', 'body', {
            value: JSON.stringify(address),
          })
        )
        const rendered = messages.find(
          message => message.role === 'assistant' && message.turnId === turn.id
        )
        assert.ok(rendered, 'Switching back lost the running turn')
        const confirmed = new Set(expectedIds)
        assert.deepEqual(
          rendered.runtimeDisplayItems.filter(item => confirmed.has(item.id)).map(item => item.id),
          expectedIds,
          'Task restoration changed or discarded the native item order'
        )
        const pane = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
        assert.equal(
          pane.text.split(PREFIX).length - 1,
          1,
          'Restoration duplicated the streaming prefix'
        )
        assert.equal(
          pane.text.split(SUFFIX.trim()).length - 1,
          1,
          'Restoration duplicated a background update'
        )
      } catch (error) {
        await diagnoseSwitchingFailure(control, uiTimeoutMs, stage)
        throw error
      } finally {
        releaseTail?.()
        releaseDone?.()
      }
      await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
    },
  }
}
