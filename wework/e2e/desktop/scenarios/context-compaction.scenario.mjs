import assert from 'node:assert/strict'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const INITIAL_PROMPT = 'WEWORK_DESKTOP_E2E_CONTEXT_COMPACTION_INITIAL'
const INITIAL_COMPLETION = 'WEWORK_DESKTOP_E2E_CONTEXT_COMPACTION_READY'
const COMPACTION_SUMMARY = 'WEWORK_DESKTOP_E2E_CONTEXT_COMPACTION_SUMMARY'
const FOLLOW_UP_PROMPT = 'WEWORK_DESKTOP_E2E_CONTEXT_COMPACTION_FOLLOW_UP'
const FOLLOW_UP_COMPLETION = 'WEWORK_DESKTOP_E2E_CONTEXT_COMPACTION_VERIFIED'

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function responseCreated(id) {
  return {
    type: 'response.created',
    response: {
      id,
      object: 'response',
      status: 'in_progress',
      output: [],
    },
  }
}

function assistantMessage(id, text) {
  return {
    type: 'response.output_item.done',
    item: {
      id: `${id}-message`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
      phase: 'final_answer',
    },
  }
}

function responseCompleted(id, inputTokens) {
  return {
    type: 'response.completed',
    response: {
      id,
      object: 'response',
      status: 'completed',
      output: [],
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: null,
        output_tokens: 20,
        output_tokens_details: null,
        total_tokens: inputTokens + 20,
      },
    },
  }
}

function requestKind(body) {
  const metadata = body.client_metadata?.['x-codex-turn-metadata']
  if (typeof metadata !== 'string') return null
  try {
    return JSON.parse(metadata).request_kind ?? null
  } catch {
    return null
  }
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function createLocalProject(control, workspacePath, timeoutMs) {
  await control.command('waitFor', '[data-testid="project-work-button"]', { timeoutMs })
  await control.command('click', '[data-testid="project-work-button"]')
  await control.command('click', '[data-testid="add-local-project-option"]')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', { timeoutMs })
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="local-project-create-dialog"]', { timeoutMs })
  await control.command('fill', '[data-testid="local-project-create-name-input"]', {
    value: 'context-compaction-e2e',
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'context-compaction-e2e',
    timeoutMs,
  })
}

async function waitForDisabled(control, selector, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if ((await control.command('getAttribute', selector, { value: 'disabled' })) !== null) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${selector} to become disabled`)
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
  let active = false
  let compactionRequests = 0
  let followUpSawCompactedContext = false
  let resolveCompactionStarted
  let releaseCompaction
  const compactionStarted = new Promise(resolve => {
    resolveCompactionStarted = resolve
  })
  const compactionRelease = new Promise(resolve => {
    releaseCompaction = resolve
  })

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/v1/responses', '/responses'].includes(url.pathname)
      ) {
        return false
      }

      const body = await readJson(request)
      const kind = requestKind(body)
      const serialized = JSON.stringify(body)
      const responseId = `wework-context-compaction-${Date.now()}`

      if (kind === 'prewarm') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(sse([responseCreated(responseId), responseCompleted(responseId, 0)]))
        return true
      }

      if (kind === 'compaction') {
        compactionRequests += 1
        resolveCompactionStarted()
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.flushHeaders()
        response.write(sse([responseCreated(responseId)]))
        await compactionRelease
        response.end(
          sse([
            assistantMessage(responseId, COMPACTION_SUMMARY),
            responseCompleted(responseId, 1200),
          ])
        )
        return true
      }

      if (serialized.includes(FOLLOW_UP_PROMPT)) {
        followUpSawCompactedContext = serialized.includes(COMPACTION_SUMMARY)
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(responseId, FOLLOW_UP_COMPLETION),
            responseCompleted(responseId, 1400),
          ])
        )
        return true
      }

      if (!serialized.includes(INITIAL_PROMPT)) return false
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(
        sse([
          responseCreated(responseId),
          assistantMessage(responseId, INITIAL_COMPLETION),
          responseCompleted(responseId, 90_000),
        ])
      )
      return true
    },

    async verify(control) {
      active = true
      await createLocalProject(control, workspacePath, uiTimeoutMs)
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('fill', COMPOSER_SELECTOR, { value: INITIAL_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: INITIAL_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="context-usage-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'context-compaction-01-ready.png', 'body')

      await control.command('click', '[data-testid="context-usage-button"]')
      await control.command('waitFor', '[data-testid="confirm-compact-context-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'context-compaction-02-confirm.png', 'body')
      await control.command('click', '[data-testid="confirm-compact-context-button"]')

      await waitForDisabled(control, '[data-testid="context-usage-button"]', uiTimeoutMs)
      await control.command('waitFor', '[data-testid="context-compaction-indicator"]', {
        text: '正在自动压缩上下文',
        timeoutMs: uiTimeoutMs,
      })
      await compactionStarted
      assert.equal(compactionRequests, 1, 'The first compact click did not start one model request')
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="context-compaction-indicator"]')
        ),
        1,
        'The running context compaction indicator was duplicated'
      )

      await captureScreenshot(control, 'context-compaction-03-running.png', 'body')
      releaseCompaction()
      await control.command('waitFor', '[data-testid="context-compaction-indicator"]', {
        timeoutMs: uiTimeoutMs,
      })
      assert.match(
        await control.command('getText', '[data-testid="context-compaction-indicator"]'),
        /上下文已自动压缩|Context compacted/
      )
      assert.equal(compactionRequests, 1, 'Context compaction was submitted more than once')
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="context-compaction-indicator"]')
        ),
        1,
        'The completed context compaction indicator was duplicated'
      )
      await captureScreenshot(control, 'context-compaction-04-completed.png', 'body')

      await control.command('fill', COMPOSER_SELECTOR, { value: FOLLOW_UP_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: FOLLOW_UP_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        followUpSawCompactedContext,
        true,
        'The follow-up model request did not contain the compacted context summary'
      )
      await captureScreenshot(control, 'context-compaction-05-follow-up-verified.png', 'body')
    },

    diagnostics() {
      return { active, compactionRequests, followUpSawCompactedContext }
    },
  }
}
