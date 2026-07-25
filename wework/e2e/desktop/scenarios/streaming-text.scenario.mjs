import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const PROMPT = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT: keep the partial response active until released.'
const MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_PARTIAL'
const VIEWPORT_MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_VIEWPORT_ANCHOR'
const APPEND_MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_APPENDED'
const INITIAL_PARAGRAPHS = Array.from({ length: 28 }, (_, index) => {
  if (index === 11) {
    return `${VIEWPORT_MARKER}: this paragraph must remain fixed after the user scrolls upward.`
  }
  return `Initial streaming paragraph ${index + 1}: enough text keeps the response taller than the desktop chat viewport.`
})
const APPENDED_PARAGRAPHS = Array.from({ length: 14 }, (_, index) =>
  index === 13
    ? `${APPEND_MARKER}: later streamed content is now visible in the response.`
    : `Later streaming paragraph ${index + 1}: this content arrives after the user pauses automatic following.`
)
const PARTIAL_TEXT = `${MARKER}: response remains active while final checks continue.\n\n${INITIAL_PARAGRAPHS.join('\n\n')}`
const APPENDED_TEXT = `\n\n${APPENDED_PARAGRAPHS.join('\n\n')}`
const COMPLETION_TEXT = `${PARTIAL_TEXT}${APPENDED_TEXT}\n\nCOMPLETE`
const SCROLLER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll"]`
const VIEWPORT_ANCHOR_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"] p[data-scroll-anchor]:nth-of-type(13)`

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

function streamingEvents(id) {
  const itemId = `${id}-message`
  return {
    itemId,
    start: [
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
        },
      },
      {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
    ],
    finish: [
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
        },
      },
      responseCompleted(id),
    ],
  }
}

function textDeltaEvents(itemId, text, initialOffset = 0) {
  let offset = initialOffset
  return (text.match(/[\s\S]{1,48}/g) ?? []).map(delta => {
    const event = {
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta,
      offset,
    }
    offset += [...delta].length
    return event
  })
}

async function writeSseEvents(response, events) {
  for (const event of events) {
    response.write(sse([event]))
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function capture(control, resultDir, name) {
  const dataUrl = await control.command('capture', ACTIVE_WORKBENCH_SELECTOR, {
    timeoutMs: 30_000,
  })
  const prefix = 'data:image/png;base64,'
  assert.ok(dataUrl.startsWith(prefix), 'Desktop screenshot did not return PNG data')
  await writeFile(join(resultDir, name), Buffer.from(dataUrl.slice(prefix.length), 'base64'))
}

function requestContainsPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(PROMPT)
}

async function getSingleElementMetrics(control, selector, description) {
  const metrics = JSON.parse(await control.command('getElementMetrics', selector))
  assert.equal(metrics.length, 1, `${description} matched ${metrics.length} elements`)
  return metrics[0]
}

export function createDesktopScenario({ resultDir, uiTimeoutMs }) {
  let releaseAppend
  let releaseResponse
  let resolveRequest
  let targetRequest
  const appendRelease = new Promise(resolve => {
    releaseAppend = resolve
  })
  const responseRelease = new Promise(resolve => {
    releaseResponse = resolve
  })
  const requestReceived = new Promise(resolve => {
    resolveRequest = resolve
  })

  return {
    codexConfigToml: '\n[features]\nplugins = false\n',

    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname)) {
        return false
      }

      const body = await readJson(request)
      const responseId = `wework-streaming-text-${Date.now()}`
      if (!requestContainsPrompt(body)) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(sse([responseCreated(responseId), responseCompleted(responseId)]))
        return true
      }

      targetRequest = body
      resolveRequest()
      const stream = streamingEvents(responseId)
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.flushHeaders()
      response.write(sse(stream.start))
      await writeSseEvents(response, textDeltaEvents(stream.itemId, PARTIAL_TEXT))
      await appendRelease
      await writeSseEvents(
        response,
        textDeltaEvents(stream.itemId, APPENDED_TEXT, PARTIAL_TEXT.length)
      )
      await responseRelease
      response.end(sse(stream.finish))
      return true
    },

    async verify(control) {
      await capture(control, resultDir, 'streaming-text-00-ready-to-send.png')
      await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await Promise.race([
        requestReceived,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('The streaming-text model request was not received')),
            uiTimeoutMs
          )
        ),
      ])
      assert.ok(
        requestContainsPrompt(targetRequest),
        'The real Codex request omitted the test prompt'
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`,
        { text: MARKER, stableMs: 750, timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="thinking-indicator"]`,
        { text: '正在思考', timeoutMs: uiTimeoutMs }
      )
      const streamingSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.ok(
        streamingSnapshot.text.indexOf(MARKER) < streamingSnapshot.text.lastIndexOf('正在思考'),
        'The thinking indicator was not rendered below the partial assistant response'
      )
      await capture(control, resultDir, 'streaming-text-01-thinking-below-partial-response.png')

      assert.equal(
        await control.command('getText', VIEWPORT_ANCHOR_SELECTOR),
        `${VIEWPORT_MARKER}: this paragraph must remain fixed after the user scrolls upward.`,
        'The viewport anchor paragraph was not rendered at the expected position'
      )
      await control.command('scrollIntoViewAsUser', VIEWPORT_ANCHOR_SELECTOR)
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="scroll-to-bottom-button"]`,
        { timeoutMs: uiTimeoutMs }
      )
      const scrollerBeforeAppend = await getSingleElementMetrics(
        control,
        SCROLLER_SELECTOR,
        'The streaming conversation scroller before later content'
      )
      const anchorBeforeAppend = await getSingleElementMetrics(
        control,
        VIEWPORT_ANCHOR_SELECTOR,
        'The viewport anchor before later content'
      )
      await capture(control, resultDir, 'streaming-text-02-user-scrolled-up.png')

      releaseAppend()
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`,
        { text: APPEND_MARKER, stableMs: 750, timeoutMs: uiTimeoutMs }
      )
      const scrollerAfterAppend = await getSingleElementMetrics(
        control,
        SCROLLER_SELECTOR,
        'The streaming conversation scroller after later content'
      )
      const anchorAfterAppend = await getSingleElementMetrics(
        control,
        VIEWPORT_ANCHOR_SELECTOR,
        'The viewport anchor after later content'
      )
      assert.ok(
        Math.abs(anchorAfterAppend.top - anchorBeforeAppend.top) <= 8,
        `The user-selected streaming text moved from ${anchorBeforeAppend.top}px to ${anchorAfterAppend.top}px while later content arrived`
      )
      assert.ok(
        Math.abs(scrollerAfterAppend.scrollTop - scrollerBeforeAppend.scrollTop) <= 8,
        `The paused streaming scroller moved from ${scrollerBeforeAppend.scrollTop}px to ${scrollerAfterAppend.scrollTop}px`
      )
      await capture(control, resultDir, 'streaming-text-03-anchor-stable-after-append.png')

      releaseResponse()
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
        { stableMs: 750, timeoutMs: uiTimeoutMs }
      )
      const completedSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.ok(
        completedSnapshot.text.includes(MARKER),
        'The completed response lost its streamed text'
      )
      assert.ok(
        !completedSnapshot.testIds.includes('thinking-indicator'),
        'The thinking indicator remained after completion'
      )
      assert.ok(
        !completedSnapshot.testIds.includes('pause-response-button'),
        'The pause button remained after completion'
      )
      await capture(control, resultDir, 'streaming-text-04-response-completed.png')
    },

    diagnostics() {
      return { receivedTargetRequest: Boolean(targetRequest) }
    },
  }
}
