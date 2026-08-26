import assert from 'node:assert/strict'

import { createSingleRootLocalProject } from '../modules/shared.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const FIRST_PROMPT = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_FIRST'
const FIRST_COMPLETION = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_FIRST_COMPLETE'
const SECOND_PROMPT = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_SECOND'
const SECOND_COMPLETION = 'WEWORK_DESKTOP_E2E_RUNNING_HISTORY_SECOND_COMPLETE'
const TRANSCRIPT_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"]`

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function responseCreated(id) {
  return { type: 'response.created', response: { id } }
}

function assistantMessage(id, text) {
  return {
    type: 'response.output_item.done',
    item: {
      id: `${id}-message`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  }
}

function streamingAssistantStart(id, text) {
  const itemId = `${id}-message`
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
      delta: text,
      offset: 0,
    },
  ]
}

function streamingAssistantCompletion(id, text) {
  const itemId = `${id}-message`
  return [
    {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
    },
    assistantMessage(id, text),
    responseCompleted(id),
  ]
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

async function waitForNewTaskRow(control, knownRows, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const row = snapshot.testIds.find(
      testId => testId.startsWith('runtime-local-task-row-') && !knownRows.has(testId)
    )
    if (row) return row
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for the running-history task row')
}

function countTextOccurrences(content, text) {
  return content.split(text).length - 1
}

async function assertRunningTaskTextNeverDuplicates(control, taskId, text, timeoutMs) {
  const startedAt = Date.now()
  let settledAt = null
  let sawText = false
  while (Date.now() - startedAt < timeoutMs) {
    const [transcriptText, debugSnapshotJson] = await Promise.all([
      control.command('getText', TRANSCRIPT_SELECTOR),
      control.command('getWorkbenchDebugSnapshot', 'body'),
    ])
    const occurrenceCount = countTextOccurrences(transcriptText, text)
    assert.ok(
      occurrenceCount <= 1,
      `Switching to the running task rendered "${text}" ${occurrenceCount} times`
    )
    sawText ||= occurrenceCount === 1

    const debugSnapshot = JSON.parse(debugSnapshotJson)
    const settled =
      sawText &&
      debugSnapshot.workbench?.currentRuntimeTask?.taskId === taskId &&
      debugSnapshot.pane?.transcript?.loading === false
    settledAt = settled ? (settledAt ?? Date.now()) : null
    if (settledAt !== null && Date.now() - settledAt >= 500) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('The running task transcript did not settle with one assistant response')
}

async function waitForRunningResponseToFinish(control, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const pauseButtonCount = Number(
      await control.command('getElementCount', '[data-testid="pause-response-button"]')
    )
    if (pauseButtonCount === 0) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The running-history follow-up did not finish after release')
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workspacePath }) {
  let active = false
  let secondRequestReceivedResolve
  let releaseSecondResponseResolve
  const secondRequestReceived = new Promise(resolve => {
    secondRequestReceivedResolve = resolve
  })
  const releaseSecondResponse = new Promise(resolve => {
    releaseSecondResponseResolve = resolve
  })

  return {
    async handleHttp(request, response, url) {
      if (!active || request.method !== 'POST') return false
      if (!['/v1/responses', '/responses'].includes(url.pathname)) return false

      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('utf8')
      const responseId = `wework-running-history-${Date.now()}`
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })

      if (body.includes(SECOND_PROMPT)) {
        response.flushHeaders()
        response.write(sse(streamingAssistantStart(responseId, SECOND_COMPLETION)))
        secondRequestReceivedResolve()
        await releaseSecondResponse
        response.end(sse(streamingAssistantCompletion(responseId, SECOND_COMPLETION)))
        return true
      }

      if (body.includes(FIRST_PROMPT)) {
        response.end(
          sse([
            ...streamingAssistantStart(responseId, FIRST_COMPLETION),
            ...streamingAssistantCompletion(responseId, FIRST_COMPLETION),
          ])
        )
        return true
      }

      response.end(sse([responseCreated(responseId), responseCompleted(responseId)]))
      return true
    },

    async verify(control) {
      active = true
      await createSingleRootLocalProject(control, workspacePath, 'running-conversation-history')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      const knownRows = new Set(
        JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
          testId.startsWith('runtime-local-task-row-')
        )
      )

      await control.command('fill', COMPOSER_SELECTOR, { value: FIRST_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: FIRST_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      const taskRowTestId = await waitForNewTaskRow(control, knownRows, uiTimeoutMs)

      await control.command('fill', COMPOSER_SELECTOR, { value: SECOND_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await Promise.race([
        secondRequestReceived,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('The running-history follow-up request was not received')),
            uiTimeoutMs
          )
        ),
      ])
      await control.command('waitFor', '[data-testid="pause-response-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: SECOND_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })

      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await assertRunningTaskTextNeverDuplicates(
        control,
        taskRowTestId.replace('runtime-local-task-row-', ''),
        FIRST_COMPLETION,
        uiTimeoutMs
      )
      await assertRunningTaskTextNeverDuplicates(
        control,
        taskRowTestId.replace('runtime-local-task-row-', ''),
        SECOND_COMPLETION,
        uiTimeoutMs
      )

      const readyCountBeforeReload = control.readyCount
      await control.command('reloadMainWindow', 'body')
      await Promise.race([
        control.awaitReadyAfter(readyCountBeforeReload),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('The reloaded Wework window did not reconnect')),
            uiTimeoutMs
          )
        ),
      ])
      await control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="message-user"]', {
        text: SECOND_PROMPT,
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(
        control,
        'running-conversation-history-01-reloaded-while-running.png',
        ACTIVE_WORKBENCH_SELECTOR
      )

      const transcriptText = await control.command(
        'getText',
        [
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`,
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        ].join(', ')
      )
      assert.ok(
        transcriptText.includes(FIRST_COMPLETION),
        'Reloading a running conversation lost the previous assistant response'
      )

      releaseSecondResponseResolve()
      await waitForRunningResponseToFinish(control, uiTimeoutMs)
      active = false
    },

    diagnostics() {
      return { active }
    },
  }
}
