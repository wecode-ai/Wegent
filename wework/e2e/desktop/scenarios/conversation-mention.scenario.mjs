import assert from 'node:assert/strict'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const SOURCE_PROMPT = 'WEWORK_CONVERSATION_REFERENCE_SOURCE: remember the launch code ORBIT-42.'
const SOURCE_COMPLETION = 'SOURCE_CONVERSATION_COMPLETE: the launch code is ORBIT-42.'
const TARGET_COMPLETION = 'REFERENCED_CONVERSATION_CONTEXT_RECEIVED'

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

function assistantMessage(text) {
  return {
    type: 'response.output_item.done',
    item: {
      id: `wework-conversation-mention-message-${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  }
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function waitForConversationOption(control, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
    const option = snapshot.testIds.find(testId =>
      testId.startsWith('conversation-reference-option-')
    )
    if (option) return option
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The referenced conversation did not appear in the @ menu')
}

async function selectConversationOption(control, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    await control.command('fill', COMPOSER_SELECTOR, { value: '' })
    await control.command('fill', COMPOSER_SELECTOR, {
      value: '@WEWORK_CONVERSATION_REFERENCE_SOURCE',
    })
    const optionTestId = await waitForConversationOption(control, timeoutMs)
    try {
      await control.command('click', `[data-testid="${optionTestId}"]`)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error('The referenced conversation could not be selected from the @ menu')
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)
  let sourceRequest = null
  let targetRequest = null

  return {
    codexConfigToml: '\n[features]\nplugins = false\n',

    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname)) {
        return false
      }

      const body = await readJson(request)
      const serialized = JSON.stringify(body)
      const responseId = `wework-conversation-mention-${Date.now()}`
      let completion = ''

      if (serialized.includes(SOURCE_PROMPT) && !serialized.includes('<application_context>')) {
        sourceRequest = body
        completion = SOURCE_COMPLETION
      } else if (serialized.includes('wework-conversation://')) {
        targetRequest = body
        completion = TARGET_COMPLETION
      }

      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(
        sse([
          responseCreated(responseId),
          ...(completion ? [assistantMessage(completion)] : []),
          responseCompleted(responseId),
        ])
      )
      return true
    },

    async verify(control) {
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('fill', COMPOSER_SELECTOR, { value: SOURCE_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: SOURCE_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      assert.ok(sourceRequest, 'The source conversation was not sent through the real runtime')

      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('fill', COMPOSER_SELECTOR, {
        value: '@WEWORK_CONVERSATION_REFERENCE_SOURCE',
      })
      await waitForConversationOption(control, uiTimeoutMs)
      const menuSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
      assert.ok(
        menuSnapshot.text.includes('WEWORK_CONVERSATION_REFERENCE_SOURCE'),
        'The @ menu selected an unrelated conversation'
      )
      await capture(control, 'conversation-mention-01-menu.png')
      await selectConversationOption(control, uiTimeoutMs)
      await control.command('waitFor', '[data-testid^="conversation-chip-"]', {
        timeoutMs: uiTimeoutMs,
      })
      await capture(control, 'conversation-mention-02-chip.png')
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: TARGET_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })

      assert.ok(targetRequest, 'Selecting the conversation mention did not send a model request')
      const serializedTarget = JSON.stringify(targetRequest)
      assert.ok(
        serializedTarget.includes('untrusted background context'),
        'The referenced conversation was not marked as untrusted background context'
      )
      assert.ok(
        serializedTarget.includes(SOURCE_PROMPT),
        'The referenced conversation omitted its user message'
      )
      assert.ok(
        serializedTarget.includes(SOURCE_COMPLETION),
        'The referenced conversation omitted its completed assistant message'
      )
      assert.ok(
        serializedTarget.includes('ORBIT-42'),
        'The referenced conversation content was not delivered to the model'
      )
      await capture(control, 'conversation-mention-03-sent.png')
    },

    diagnostics() {
      return {
        receivedSourceRequest: Boolean(sourceRequest),
        receivedTargetRequest: Boolean(targetRequest),
      }
    },
  }
}
