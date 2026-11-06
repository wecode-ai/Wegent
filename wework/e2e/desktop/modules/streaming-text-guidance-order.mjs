import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from './executor-rpc.mjs'
import {
  createSse,
  functionCall,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectTool,
  streamingTextEvents,
} from './response-protocol.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  ASSISTANT_CONTENT_SELECTOR,
  COMPOSER_SELECTOR,
  openNewChatWithE2EModel,
  waitForRuntimePaneReadyToSend,
} from './streaming-text-fixture.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'

const PROMPT = 'WEWORK_STREAMING_GUIDANCE_ORDER'
const QUESTION = 'Where should the new agent run?'
const ANSWER = 'Create a cloud environment'
const PREFIX = 'The environment provider will create a server. Code'
const PROGRESS = 'STREAMING_GUIDANCE_PROGRESS: connecting the creation entry points.'
const COMPLETE = 'STREAMING_GUIDANCE_COMPLETE: the cloud environment is connected.'
const CALL = 'streaming-guidance-question'

/** Exercise actual async input preemption; only the model transport is simulated. */
export function createStreamingGuidanceOrderChecks({ resultDir, uiTimeoutMs }) {
  const held = new Set()
  let releaseCompletion
  const completion = new Promise(resolve => {
    releaseCompletion = resolve
  })
  let requests = 0

  const delta = (stream, text) => ({
    type: 'response.output_text.delta',
    item_id: stream.itemId,
    output_index: 0,
    content_index: 0,
    delta: text,
  })

  async function readAndAssertOrder(control, address, label) {
    const transcript = await requestExecutor(
      control,
      'runtime.tasks.transcript',
      {
        address,
        refresh: true,
      },
      uiTimeoutMs
    )
    await writeFile(
      join(resultDir, `streaming-guidance-${label}.json`),
      JSON.stringify(transcript, null, 2)
    )
    const items = transcript.turns.at(-1).items
    const prefix = items.findIndex(
      item => item.content?.includes(PREFIX) || item.block?.content?.includes(PREFIX)
    )
    const answer = items.findIndex(
      item => item.type === 'user_message' && item.message.content.includes(ANSWER)
    )
    const progress = items.findIndex(item => item.block?.content?.includes(PROGRESS))
    assert.ok(answer >= 0 && progress > answer, 'The accepted answer must precede the new progress')
    if (label === 'running' || label === 'restored')
      assert.ok(prefix >= 0, 'The running history lost the interrupted reply')
    assert.ok(
      prefix < answer,
      'The interrupted reply was appended after its guidance and newer progress'
    )
    const messages = JSON.parse(
      await control.command('getRuntimeConversationMessages', 'body', {
        value: JSON.stringify(address),
      })
    )
    await writeFile(
      join(resultDir, `streaming-guidance-${label}-rendered.json`),
      JSON.stringify(messages, null, 2)
    )
    const renderedAnswer = messages.findIndex(
      message => message.role === 'user' && message.content.includes(ANSWER)
    )
    const renderedPrefix = messages.findIndex(
      message => message.role === 'assistant' && message.content.includes(PREFIX)
    )
    assert.ok(
      renderedAnswer >= 0 && renderedPrefix < renderedAnswer,
      'The renderer moved the interrupted reply after its guidance'
    )
    assert.ok(
      messages
        .slice(renderedAnswer + 1)
        .some(message => message.blocks?.some(block => block.content?.includes(PROGRESS))),
      'The renderer lost the progress following the answer'
    )
    return transcript
  }

  return {
    cleanup() {
      releaseCompletion()
      for (const response of held) response.end()
    },
    async handleModelRequest(body, response, id) {
      if (!JSON.stringify(body.input).includes(PROMPT)) return false
      requests += 1
      assert.ok(requests <= 3, 'Async guidance invoked a duplicate model request')
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      if (!requestContainsToolOutput(body, CALL)) {
        const tool = selectTool(body, 'request_user_input_async', {
          questions: [{ title: QUESTION, options: [ANSWER, 'Use this computer'] }],
        })
        response.end(
          createSse([
            responseCreated(id),
            ...functionCall(CALL, tool.name, tool.arguments),
            responseCompleted(id),
          ])
        )
        return true
      }
      const answered = body.input.some(
        item => item.role === 'user' && JSON.stringify(item).includes(ANSWER)
      )
      if (!answered) {
        const stream = streamingTextEvents(id, PREFIX, 'final_answer')
        response.write(createSse([...stream.start, delta(stream, PREFIX)]))
        held.add(response)
        await new Promise(resolve => response.once('close', resolve))
        held.delete(response)
        return true
      }
      const progress = streamingTextEvents(`${id}-progress`, PROGRESS, 'commentary')
      response.write(
        createSse([
          ...progress.start,
          delta(progress, PROGRESS),
          ...progress.finish.filter(event => event.type !== 'response.completed'),
        ])
      )
      await completion
      const final = streamingTextEvents(`${id}-final`, COMPLETE, 'final_answer')
      response.end(
        createSse([
          ...final.start.filter(event => event.type !== 'response.created'),
          delta(final, COMPLETE),
          ...final.finish,
        ])
      )
      return true
    },
    async verify(control) {
      try {
        await openNewChatWithE2EModel(control, uiTimeoutMs)
        await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
        await control.command(
          'clickWhenEnabled',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        const card = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-card"]`
        await control.command('waitFor', card, { text: QUESTION, visible: true })
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: PREFIX })
        const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        const address = debug.workbench.currentRuntimeTask
        const selectedAnswer = await control.command(
          'clickWhenEnabled',
          `${card} [data-testid="request-user-input-option-question_1-0"]`
        )
        assert.ok(selectedAnswer.includes(ANSWER), 'The intended async answer was not selected')
        await waitForWorkbenchDebugState(
          control,
          snapshot => requests === 3 && snapshot.pane?.status?.isBusy === true,
          'The answer did not preempt the streaming reply and start new progress',
          uiTimeoutMs
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"]`,
          { text: PROGRESS, visible: true }
        )
        await readAndAssertOrder(control, address, 'running')
        const readyCount = control.readyCount
        await control.command('reloadMainWindow', 'body')
        await control.awaitReadyAfter(readyCount)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"]`,
          { text: PROGRESS, visible: true }
        )
        await readAndAssertOrder(control, address, 'restored')
        releaseCompletion()
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: COMPLETE })
        await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
        await readAndAssertOrder(control, address, 'completed')
        const completedReadyCount = control.readyCount
        await control.command('reloadMainWindow', 'body')
        await control.awaitReadyAfter(completedReadyCount)
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: COMPLETE })
        await readAndAssertOrder(control, address, 'completed-restored')
        assert.equal(requests, 3)
      } finally {
        this.cleanup()
      }
    },
  }
}
