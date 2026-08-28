import assert from 'node:assert/strict'

import { createSingleRootLocalProject } from '../modules/shared.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const ASSISTANT_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
const PROMPT = 'WEWORK_DESKTOP_E2E_EXECUTOR_STREAM_RECOVERY'
const PARTIAL_TEXT = 'WEWORK_DESKTOP_E2E_EXECUTOR_STREAM_PARTIAL'
const COMPLETION_TEXT =
  'WEWORK_DESKTOP_E2E_EXECUTOR_STREAM_PARTIAL_AND_COMPLETED_WHILE_RENDERER_RELOADED'

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function responseCreated(id) {
  return { type: 'response.created', response: { id } }
}

function responseCompleted(id) {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  }
}

function streamStart(id, itemId) {
  return [
    responseCreated(id),
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
        phase: 'final_answer',
      },
    },
    {
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: PARTIAL_TEXT,
      offset: 0,
    },
  ]
}

function streamFinish(id, itemId) {
  const suffix = COMPLETION_TEXT.slice(PARTIAL_TEXT.length)
  return [
    {
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: suffix,
      offset: PARTIAL_TEXT.length,
    },
    {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: COMPLETION_TEXT,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: COMPLETION_TEXT, annotations: [] }],
        phase: 'final_answer',
      },
    },
    responseCompleted(id),
  ]
}

async function waitForSettled(control, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
    if (
      !snapshot.testIds.includes('pause-response-button') &&
      !snapshot.testIds.includes('thinking-indicator')
    ) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The recovered executor stream remained in a running state')
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
  let active = false
  let requestStartedResolve
  let releaseCompletionResolve
  const requestStarted = new Promise(resolve => {
    requestStartedResolve = resolve
  })
  const releaseCompletion = new Promise(resolve => {
    releaseCompletionResolve = resolve
  })

  return {
    async handleHttp(request, response, url) {
      if (!active || request.method !== 'POST') return false
      if (!['/v1/responses', '/responses'].includes(url.pathname)) return false

      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('utf8')
      assert.ok(body.includes(PROMPT), 'The executor stream recovery prompt was not preserved')

      const responseId = `wework-executor-stream-recovery-${Date.now()}`
      const itemId = `${responseId}-message`
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.flushHeaders()
      response.write(sse(streamStart(responseId, itemId)))
      requestStartedResolve()
      await releaseCompletion
      response.end(sse(streamFinish(responseId, itemId)))
      return true
    },

    async verify(control) {
      active = true
      await createSingleRootLocalProject(control, workspacePath, 'executor-stream-recovery')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await Promise.race([
        requestStarted,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('The executor stream recovery request was not received')),
            uiTimeoutMs
          )
        ),
      ])
      await control.command('waitFor', ASSISTANT_SELECTOR, {
        text: PARTIAL_TEXT,
        timeoutMs: uiTimeoutMs,
      })

      const readyCountBeforeReload = control.readyCount
      await control.command('reloadMainWindow', 'body')
      releaseCompletionResolve()
      await Promise.race([
        control.awaitReadyAfter(readyCountBeforeReload),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('The renderer did not reconnect during executor replay')),
            uiTimeoutMs
          )
        ),
      ])

      await control.command('waitFor', ASSISTANT_SELECTOR, {
        text: COMPLETION_TEXT,
        timeoutMs: uiTimeoutMs,
      })
      await waitForSettled(control, uiTimeoutMs)
      const assistantText = await control.command('getText', ASSISTANT_SELECTOR)
      assert.equal(
        assistantText.includes(COMPLETION_TEXT),
        true,
        'Executor replay did not restore the output completed while the renderer was unavailable'
      )
      await captureScreenshot(
        control,
        'executor-stream-recovery-01-completed-after-renderer-reload.png',
        ACTIVE_WORKBENCH_SELECTOR
      )
      active = false
    },

    diagnostics() {
      return { active }
    },
  }
}
