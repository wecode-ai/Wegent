import assert from 'node:assert/strict'

const COMPOSER =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"] [data-testid="chat-message-input"][contenteditable="true"]'
const INDICATOR = '[data-testid="context-compaction-indicator"]'
const SEED = 'WEWORK_E2E_INTERRUPTED_COMPACTION_SEED'
const FOLLOW_UP = 'WEWORK_E2E_INTERRUPTED_COMPACTION_FOLLOW_UP'
const SUMMARY = 'WEWORK_E2E_INTERRUPTED_COMPACTION_SUMMARY'
const COMPLETE = 'WEWORK_E2E_INTERRUPTED_COMPACTION_RECOVERED'

function finish(response, id, text, inputTokens) {
  response.end(
    [
      {
        type: 'response.output_item.done',
        item: {
          id: `${id}-message`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
          phase: 'final_answer',
        },
      },
      {
        type: 'response.completed',
        response: {
          id,
          usage: { input_tokens: inputTokens, output_tokens: 20, total_tokens: inputTokens + 20 },
        },
      },
    ]
      .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join('')
  )
}

export function createInterruptedCompactionScenario({ uiTimeoutMs, modelResponseTimeoutMs }) {
  let active = false
  let compactionRequests = 0
  let heldResponse
  let recoveredWithSummary = false
  let notifyCompactionStarted
  const compactionStarted = new Promise(resolve => {
    notifyCompactionStarted = resolve
  })

  async function send(control, text) {
    await control.command('fill', COMPOSER, { value: text })
    await control.command(
      'waitFor',
      '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"] [data-testid="send-message-button"]',
      { enabled: true, timeoutMs: uiTimeoutMs }
    )
    await control.command('press', COMPOSER, { key: 'Enter' })
  }

  async function waitIdle(control) {
    const start = Date.now()
    while (Date.now() - start < modelResponseTimeoutMs) {
      const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      if (snapshot.pane?.status?.isBusy === false) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Interrupted compaction turn did not settle')
  }

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/v1/responses', '/responses'].includes(url.pathname)
      )
        return false
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const kind = JSON.parse(body.client_metadata?.['x-codex-turn-metadata'] ?? '{}').request_kind
      const id = `interrupted-compaction-${Date.now()}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      response.write(
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id } })}\n\n`
      )
      if (kind === 'prewarm') {
        finish(response, id, '', 0)
      } else if (kind === 'compaction') {
        compactionRequests += 1
        if (compactionRequests === 1) {
          heldResponse = response
          notifyCompactionStarted()
        } else {
          finish(response, id, SUMMARY, 1200)
        }
      } else if (JSON.stringify(body).includes(FOLLOW_UP)) {
        recoveredWithSummary = JSON.stringify(body).includes(SUMMARY)
        finish(response, id, COMPLETE, 1400)
      } else {
        // Exhaust the real Codex budget so the next user turn auto-compacts.
        finish(response, id, SEED, 260_000)
      }
      return true
    },
    async verify(control) {
      active = true
      try {
        await send(control, SEED)
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: SEED,
          timeoutMs: modelResponseTimeoutMs,
        })
        await waitIdle(control)
        const previousIndicators = Number(await control.command('getElementCount', INDICATOR))
        await send(control, FOLLOW_UP)
        await control.command('waitFor', INDICATOR, {
          text: '正在自动压缩上下文',
          timeoutMs: modelResponseTimeoutMs,
        })
        await Promise.race([
          compactionStarted,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Compaction model request did not start')),
              modelResponseTimeoutMs
            )
          ),
        ])
        assert.equal(compactionRequests, 1)
        await control.command('click', '[data-testid="pause-response-button"]')
        await waitIdle(control)
        await control.command('waitFor', INDICATOR, {
          text: '上下文压缩未完成',
          timeoutMs: uiTimeoutMs,
        })
        const indicators = await control.command('getText', INDICATOR)
        assert.ok(indicators.includes('上下文压缩未完成'))
        const readyCount = control.readyCount
        await control.command('reloadMainWindow', 'body')
        await Promise.race([
          control.awaitReadyAfter(readyCount),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Reload did not reconnect')), uiTimeoutMs)
          ),
        ])
        await control.command('waitFor', COMPOSER, { timeoutMs: uiTimeoutMs })
        await waitIdle(control)
        // A cancelled attempt may be absent from Codex history, but must never become a success.
        const texts = await control.command('getText', INDICATOR)
        assert.equal(texts.split('上下文已自动压缩').length - 1, previousIndicators)
        await send(control, FOLLOW_UP)
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: COMPLETE,
          timeoutMs: modelResponseTimeoutMs,
        })
        assert.equal(compactionRequests, 2)
        assert.equal(recoveredWithSummary, true)
        await waitIdle(control)
        const recoveredText = await control.command('getText', INDICATOR)
        assert.equal(recoveredText.split('上下文已自动压缩').length - 1, previousIndicators + 1)
      } finally {
        heldResponse?.destroy()
        active = false
      }
    },
    diagnostics() {
      return { active, compactionRequests, recoveredWithSummary }
    },
  }
}
