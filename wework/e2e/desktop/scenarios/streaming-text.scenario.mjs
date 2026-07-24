import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const PROMPT = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT: keep the partial response active until released.'
const MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_PARTIAL'
const PARTIAL_TEXT = `${MARKER}: response remains active while final checks continue.`
const COMPLETION_TEXT = `${PARTIAL_TEXT} COMPLETE`

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

export function createDesktopScenario({ resultDir, uiTimeoutMs }) {
  let releaseResponse
  let resolveRequest
  let targetRequest
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
      response.write(
        sse([
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta: PARTIAL_TEXT,
            offset: 0,
          },
        ])
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
      await capture(control, resultDir, 'streaming-text-02-response-completed.png')
    },

    diagnostics() {
      return { receivedTargetRequest: Boolean(targetRequest) }
    },
  }
}
