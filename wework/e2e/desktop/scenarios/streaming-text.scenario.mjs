import assert from 'node:assert/strict'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const TOOL_REGRESSION_PROMPT = 'WEWORK_DESKTOP_E2E_TOOL_TEXT_OFFSET'
const TOOL_PREAMBLE = '找到了关键错误。看一下失败前后的上下文：'
const TOOL_COMPLETION = '本地分支落后于 main，CI 跑的提交是 719f99694。'
const TIMER_PROMPT = 'WEWORK_DESKTOP_E2E_RUNNING_TIMER_PERSISTS'
const TIMER_COMPLETION = 'WEWORK_DESKTOP_E2E_RUNNING_TIMER_COMPLETE'
const ORDER_STOP_PROMPT = 'WEWORK_DESKTOP_E2E_ORDER_STOPPED_TURN'
const ORDER_FOLLOW_UP_PREFIX = 'WEWORK_DESKTOP_E2E_ORDER_FOLLOW_UP'
const ORDER_COMPLETION_PREFIX = 'WEWORK_DESKTOP_E2E_ORDER_COMPLETION'
const ORDER_FOLLOW_UP_COUNT = 26
const HIDDEN_REASONING = 'WEWORK_DESKTOP_E2E_HIDDEN_REASONING_CONTENT'
const REASONING_SUMMARY = 'WEWORK_DESKTOP_E2E_REASONING_SUMMARY'
const INITIAL_PROMPT = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_INITIAL'
const HISTORY_PROMPT_PREFIX = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_HISTORY'
const PROMPT = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT: keep the partial response active until released.'
const MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_PARTIAL'
const VIEWPORT_MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_VIEWPORT_ANCHOR'
const APPEND_MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_APPENDED'
const ATTACHMENT_FILENAME = 'streaming-turn-navigation.png'
const ATTACHMENT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC'
const TURN_NAVIGATION_MARKER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-marker"]`
const SCROLLER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`
const ASSISTANT_CONTENT_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`
const THINKING_INDICATOR_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="thinking-indicator"]`
const USER_MESSAGE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
const USER_MESSAGE_E2E_ID = 'streaming-text-latest-user-message'
const USER_MESSAGE_SELECTOR_MARKED = `${ACTIVE_WORKBENCH_SELECTOR} [data-e2e-anchor-id="${USER_MESSAGE_E2E_ID}"]`
const PROCESSING_SUMMARY_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="processing-summary-header"]`
const VIEWPORT_ANCHOR_TEXT = `${VIEWPORT_MARKER}: this paragraph must remain fixed after the user scrolls upward.`
const VIEWPORT_ANCHOR_E2E_ID = 'streaming-text-viewport-anchor'
const VIEWPORT_ANCHOR_SCOPE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"] [data-scroll-anchor]`
const VIEWPORT_ANCHOR_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-e2e-anchor-id="${VIEWPORT_ANCHOR_E2E_ID}"]`
const HISTORY_PARAGRAPHS = Array.from({ length: 28 }, (_, index) => {
  if (index === 11) {
    return VIEWPORT_ANCHOR_TEXT
  }
  return `Completed history paragraph ${index + 1}: this content belongs to the previous assistant turn.`
})
const INITIAL_COMPLETION = `WEWORK_DESKTOP_E2E_STREAMING_TEXT_INITIAL_COMPLETE\n\n${HISTORY_PARAGRAPHS.join('\n\n')}`
const HISTORY_TURNS = Array.from({ length: 4 }, (_, index) => ({
  prompt: `${HISTORY_PROMPT_PREFIX}_${index + 1}`,
  completion: `WEWORK_DESKTOP_E2E_STREAMING_TEXT_HISTORY_COMPLETE_${index + 1}\n\n${Array.from(
    { length: 4 },
    (_, paragraphIndex) =>
      `Follow-up history paragraph ${index + 1}.${paragraphIndex + 1}: this turn keeps the conversation on the virtualized path.`
  ).join('\n\n')}`,
}))
const STREAMING_TURN_INDEX = HISTORY_TURNS.length + 1
const PANE_EVICTION_BLANK_COUNT = 4
const INITIAL_PARAGRAPHS = Array.from({ length: 28 }, (_, index) => {
  return `Initial streaming paragraph ${index + 1}: enough text keeps the response taller than the desktop chat viewport.`
})
const APPENDED_PARAGRAPHS = Array.from({ length: 14 }, (_, index) =>
  index === 0
    ? `${APPEND_MARKER}: later streamed content is now visible in the response.`
    : `Later streaming paragraph ${index + 1}: this content arrives after the user pauses automatic following.`
)
const PARTIAL_TEXT = `${MARKER}: response remains active while final checks continue.\n\n${INITIAL_PARAGRAPHS.join('\n\n')}`
const APPENDED_TEXT = `\n\n${APPENDED_PARAGRAPHS.join('\n\n')}`
const COMPLETION_TEXT = `${PARTIAL_TEXT}${APPENDED_TEXT}\n\nCOMPLETE`

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
      id: `wework-streaming-text-message-${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  }
}

function functionCall(callId, name, argumentsValue) {
  return [
    {
      type: 'response.output_item.added',
      item: {
        type: 'function_call',
        call_id: callId,
        name,
      },
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: callId,
        name,
        arguments: JSON.stringify(argumentsValue),
      },
    },
  ]
}

function reasoningEvents(itemId, text) {
  return [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: itemId,
        type: 'reasoning',
        status: 'in_progress',
        summary: [],
      },
    },
    {
      type: 'response.reasoning_summary_part.added',
      item_id: itemId,
      output_index: 0,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    },
    {
      type: 'response.reasoning_summary_text.delta',
      item_id: itemId,
      output_index: 0,
      summary_index: 0,
      delta: text,
    },
    {
      type: 'response.reasoning_summary_text.done',
      item_id: itemId,
      output_index: 0,
      summary_index: 0,
      text,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: itemId,
        type: 'reasoning',
        status: 'completed',
        summary: [{ type: 'summary_text', text }],
      },
    },
  ]
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
  return [
    {
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
      offset: initialOffset,
    },
  ]
}

async function writeSseEvents(response, events) {
  for (const event of events) {
    response.write(sse([event]))
    response.flush?.()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function requestContainsPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(PROMPT)
}

function requestContainsInitialPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(INITIAL_PROMPT)
}

function findHistoryTurn(body) {
  const input = JSON.stringify(body.input ?? [])
  return HISTORY_TURNS.findLast(turn => input.includes(turn.prompt))
}

function requestContainsToolRegressionPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(TOOL_REGRESSION_PROMPT)
}

function requestContainsTimerPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(TIMER_PROMPT)
}

function latestModelInputText(body) {
  const input = Array.isArray(body.input) ? body.input.at(-1) : body.input
  const message = Array.isArray(body.messages) ? body.messages.at(-1) : null
  return JSON.stringify(input ?? message ?? '')
}

function orderFollowUpNumber(body) {
  const match = latestModelInputText(body).match(new RegExp(`${ORDER_FOLLOW_UP_PREFIX}_(\\d+)`))
  return match ? Number(match[1]) : null
}

function requestContainsToolOutput(body) {
  return JSON.stringify(body.input ?? []).includes('function_call_output')
}

function selectShellTool(body, workspacePath, command = 'pwd', timeoutMs = 1_000) {
  const tools = Array.isArray(body.tools) ? body.tools : []
  const names = new Set(tools.map(tool => tool?.name).filter(Boolean))
  if (names.has('exec_command')) {
    return {
      name: 'exec_command',
      arguments: {
        cmd: command,
        workdir: workspacePath,
        timeout_ms: timeoutMs,
        yield_time_ms: timeoutMs,
      },
    }
  }
  assert.ok(names.has('shell_command'), `Real Codex did not advertise a shell tool: ${[...names]}`)
  return {
    name: 'shell_command',
    arguments: {
      command,
      workdir: workspacePath,
      timeout_ms: timeoutMs,
    },
  }
}

async function getSingleElementMetrics(control, selector, description) {
  const metrics = JSON.parse(await control.command('getElementMetrics', selector))
  assert.equal(metrics.length, 1, `${description} matched ${metrics.length} elements`)
  return metrics[0]
}

function distanceFromBottom(metrics) {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop)
}

function assertElementFullyVisible(elementMetrics, scrollerMetrics, description) {
  assert.ok(
    elementMetrics.top >= scrollerMetrics.top && elementMetrics.bottom <= scrollerMetrics.bottom,
    `${description} was not fully visible (element=${elementMetrics.top}-${elementMetrics.bottom}, scroller=${scrollerMetrics.top}-${scrollerMetrics.bottom})`
  )
}

function toolDurationSeconds(text) {
  return Number(text.match(/(\d+(?:\.\d+)?)s/)?.[1] ?? 0)
}

async function waitForToolDuration(control, minimumSeconds, timeoutMs) {
  const startedAt = Date.now()
  let text = ''
  const selector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="tool-block-duration"]`
  await control.command('waitFor', selector, { timeoutMs })
  while (Date.now() - startedAt < timeoutMs) {
    text = await control.command('getText', selector)
    const duration = toolDurationSeconds(text)
    if (duration >= minimumSeconds) return duration
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`The running tool duration did not reach ${minimumSeconds}s; latest row: ${text}`)
}

async function waitForBottom(control, description, timeoutMs) {
  const startedAt = Date.now()
  let metrics
  while (Date.now() - startedAt < timeoutMs) {
    metrics = await getSingleElementMetrics(control, SCROLLER_SELECTOR, description)
    if (distanceFromBottom(metrics) <= 8) return metrics
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${description} remained ${distanceFromBottom(metrics)}px from the bottom`)
}

async function waitForScrollHeightIncrease(control, previousHeight, description, timeoutMs) {
  const startedAt = Date.now()
  let metrics
  while (Date.now() - startedAt < timeoutMs) {
    metrics = await getSingleElementMetrics(control, SCROLLER_SELECTOR, description)
    if (metrics.scrollHeight > previousHeight + 8) return metrics
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(
    `${description} remained at ${metrics?.scrollHeight ?? previousHeight}px after content was appended`
  )
}

async function waitForFolderPath(control, expectedPath, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const inputValue = await control.command('getValue', '[data-testid="device-folder-path-input"]')
    const directoryText = await control.command(
      'getText',
      '[data-testid="device-folder-directory-list"]'
    )
    if (inputValue === expectedPath && !/Loading directories|正在加载目录/.test(directoryText)) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`The streaming-text project picker did not load ${expectedPath}`)
}

async function waitForProjectWorkButton(control, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (Number(await control.command('getElementCount', '[data-testid="project-work-button"]'))) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The streaming-text project selector did not become available')
}

async function waitForProjectBranch(control, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const branch = await control.command('getText', '[data-testid="project-branch-button"]')
    if (branch && !/Loading|加载中/.test(branch)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The streaming-text project branch did not finish loading')
}

async function createLocalProject(control, workspacePath, timeoutMs) {
  await waitForProjectWorkButton(control, timeoutMs)
  await control.command('click', '[data-testid="project-work-button"]')
  await control.command('click', '[data-testid="add-local-project-option"]')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', { timeoutMs })
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await waitForFolderPath(control, workspacePath, timeoutMs)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="local-project-create-dialog"]', { timeoutMs })
  await control.command('fill', '[data-testid="local-project-create-name-input"]', {
    value: 'streaming-navigation',
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'streaming-navigation',
    timeoutMs,
  })
  await waitForProjectBranch(control, timeoutMs)
}

async function waitForNewTaskRow(control, knownTaskRows, expectedText, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const candidates = snapshot.testIds.filter(
      testId => testId.startsWith('runtime-local-task-row-') && !knownTaskRows.has(testId)
    )
    for (const testId of candidates) {
      const text = await control.command('getText', `[data-testid="${testId}"]`)
      if (text.includes(expectedText)) return testId
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`The streaming task row did not appear for ${expectedText}`)
}

export function createDesktopScenario({
  captureScreenshot,
  standalone,
  uiTimeoutMs,
  workspacePath,
}) {
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)
  let active = false
  let toolRegressionStage = 'initial'
  let timerStage = 'initial'
  let releaseAppend
  let releaseResponse
  let releaseStart
  let resolveRequest
  let targetRequest
  const appendRelease = new Promise(resolve => {
    releaseAppend = resolve
  })
  const responseRelease = new Promise(resolve => {
    releaseResponse = resolve
  })
  const startRelease = new Promise(resolve => {
    releaseStart = resolve
  })
  const requestReceived = new Promise(resolve => {
    resolveRequest = resolve
  })

  const verifyStoppedTurnOrder = async control => {
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
    const knownOrderTaskRows = new Set(
      JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
        testId.startsWith('runtime-local-task-row-')
      )
    )
    await control.command('fill', COMPOSER_SELECTOR, { value: ORDER_STOP_PROMPT })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    const orderTaskRowTestId = await waitForNewTaskRow(
      control,
      knownOrderTaskRows,
      ORDER_STOP_PROMPT,
      uiTimeoutMs
    )
    await control.command('waitFor', '[data-testid="pause-response-button"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="pause-response-button"]')
    await control.command('waitFor', '[data-testid="assistant-stopped-notice"]', {
      timeoutMs: uiTimeoutMs,
    })
    for (let index = 1; index <= ORDER_FOLLOW_UP_COUNT; index += 1) {
      const prompt = `${ORDER_FOLLOW_UP_PREFIX}_${index}`
      const completion = `${ORDER_COMPLETION_PREFIX}_${index}`
      await control.command('fill', COMPOSER_SELECTOR, { value: prompt })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
        text: completion,
        timeoutMs: uiTimeoutMs,
      })
    }
    for (let index = 0; index < PANE_EVICTION_BLANK_COUNT; index += 1) {
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
    }
    await control.command('clickWhenEnabled', `[data-testid="${orderTaskRowTestId}"]`, {
      timeoutMs: uiTimeoutMs,
    })
    const latestOrderCompletion = `${ORDER_COMPLETION_PREFIX}_${ORDER_FOLLOW_UP_COUNT}`
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: latestOrderCompletion,
      stableMs: 750,
      timeoutMs: uiTimeoutMs,
    })
    assert.equal(
      Number(await control.command('getElementCount', '[data-testid="assistant-stopped-notice"]')),
      0,
      'The latest transcript position remained on the older stopped turn'
    )
    await capture(control, 'streaming-text-16-stopped-turn-order-restored.png')
  }

  return {
    async handleHttp(request, response, url) {
      if (!active) return false
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname)) {
        return false
      }

      const body = await readJson(request)
      const responseId = `wework-streaming-text-${Date.now()}`
      const latestInput = latestModelInputText(body)
      if (latestInput.includes(ORDER_STOP_PROMPT)) {
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.flushHeaders()
        response.write(sse([responseCreated(responseId)]))
        return true
      }
      const followUpNumber = orderFollowUpNumber(body)
      if (followUpNumber !== null) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(`${ORDER_COMPLETION_PREFIX}_${followUpNumber}`),
            responseCompleted(responseId),
          ])
        )
        return true
      }
      if (timerStage === 'awaiting-tool-output' && requestContainsToolOutput(body)) {
        timerStage = 'complete'
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(TIMER_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
      }
      if (toolRegressionStage === 'awaiting-tool-output' && requestContainsToolOutput(body)) {
        toolRegressionStage = 'complete'
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(TOOL_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      if (requestContainsTimerPrompt(body)) {
        if (timerStage === 'initial') {
          const tool = selectShellTool(body, workspacePath, 'sleep 15', 20_000)
          timerStage = 'awaiting-tool-output'
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
          response.end(
            sse([
              responseCreated(responseId),
              ...functionCall('wework-running-timer', tool.name, tool.arguments),
              responseCompleted(responseId),
            ])
          )
          return true
        }
        throw new Error(`Unexpected running-timer stage: ${timerStage}`)
      }

      if (requestContainsPrompt(body)) {
        targetRequest = body
        resolveRequest()
        await startRelease
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
      }

      if (requestContainsToolRegressionPrompt(body)) {
        if (toolRegressionStage === 'initial') {
          const tool = selectShellTool(body, workspacePath)
          toolRegressionStage = 'awaiting-tool-output'
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
          response.end(
            sse([
              responseCreated(responseId),
              ...reasoningEvents('wework-reasoning-summary', REASONING_SUMMARY),
              assistantMessage(TOOL_PREAMBLE),
              ...functionCall('wework-tool-text-offset', tool.name, tool.arguments),
              responseCompleted(responseId),
            ])
          )
          return true
        }
        throw new Error(`Unexpected tool-text-offset stage: ${toolRegressionStage}`)
      }

      const historyTurn = findHistoryTurn(body)
      if (historyTurn) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(historyTurn.completion),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      if (requestContainsInitialPrompt(body)) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(INITIAL_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(sse([responseCreated(responseId), responseCompleted(responseId)]))
      return true
    },

    async verify(control) {
      active = true
      if (standalone) {
        await createLocalProject(control, workspacePath, uiTimeoutMs)
      } else {
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      }
      if (process.env.WEWORK_E2E_MESSAGE_ORDER_ONLY === 'true') {
        await verifyStoppedTurnOrder(control)
        active = false
        return
      }
      await control.command('fill', COMPOSER_SELECTOR, { value: TOOL_REGRESSION_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: TOOL_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      const toolRegressionSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.ok(
        toolRegressionSnapshot.text.includes(TOOL_COMPLETION),
        'The assistant text after the tool call lost its prefix'
      )
      assert.equal(
        toolRegressionSnapshot.text.includes(REASONING_SUMMARY),
        false,
        'The collapsed reasoning disclosure exposed its full summary'
      )
      await capture(control, 'streaming-text-00-processing-collapsed.png')
      await control.command('click', '[data-testid="final-processing-toggle"]')
      const expandedProcessingSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.equal(
        expandedProcessingSnapshot.testIds.includes('thinking-toggle-button'),
        false,
        'The completed response retained a reasoning placeholder'
      )
      assert.equal(
        expandedProcessingSnapshot.text.includes(REASONING_SUMMARY),
        false,
        'The completed response retained its reasoning summary'
      )
      await capture(control, 'streaming-text-01-reasoning-removed.png')

      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      const knownTimerTaskRows = new Set(
        JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
          testId.startsWith('runtime-local-task-row-')
        )
      )
      await control.command('fill', COMPOSER_SELECTOR, { value: TIMER_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      const timerTaskRowTestId = await waitForNewTaskRow(
        control,
        knownTimerTaskRows,
        TIMER_PROMPT,
        uiTimeoutMs
      )
      const toolDurationBeforeSwitch = await waitForToolDuration(control, 3, uiTimeoutMs)
      const summaryBeforeSwitch = await control.command('getText', PROCESSING_SUMMARY_SELECTOR)
      assert.equal(
        toolDurationSeconds(summaryBeforeSwitch),
        0,
        `The tool summary exposed an aggregate duration: ${summaryBeforeSwitch}`
      )
      await capture(control, 'streaming-text-03-running-tool.png')
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('clickWhenEnabled', `[data-testid="${timerTaskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      const toolDurationAfterSwitch = await waitForToolDuration(control, 1, uiTimeoutMs)
      assert.ok(
        toolDurationAfterSwitch >= toolDurationBeforeSwitch,
        `The running tool timer reset from ${toolDurationBeforeSwitch}s to ${toolDurationAfterSwitch}s after switching pages`
      )
      const summaryAfterSwitch = await control.command('getText', PROCESSING_SUMMARY_SELECTOR)
      assert.equal(
        toolDurationSeconds(summaryAfterSwitch),
        0,
        `The restored tool summary exposed an aggregate duration: ${summaryAfterSwitch}`
      )
      await capture(control, 'streaming-text-04-running-tool-restored.png')
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: TIMER_COMPLETION,
        timeoutMs: 25_000,
      })
      await capture(control, 'streaming-text-05-tool-completed.png')

      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      const knownTaskRows = new Set(
        JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
          testId.startsWith('runtime-local-task-row-')
        )
      )
      await control.command('fill', COMPOSER_SELECTOR, { value: INITIAL_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_INITIAL_COMPLETE',
        timeoutMs: uiTimeoutMs,
      })
      const taskRowTestId = await waitForNewTaskRow(
        control,
        knownTaskRows,
        INITIAL_PROMPT,
        uiTimeoutMs
      )
      for (const historyTurn of HISTORY_TURNS) {
        await control.command('fill', COMPOSER_SELECTOR, { value: historyTurn.prompt })
        await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: historyTurn.completion.split('\n')[0],
          timeoutMs: uiTimeoutMs,
        })
      }
      await capture(control, 'streaming-text-10-ready-to-send.png')
      await control.command('pasteFile', COMPOSER_SELECTOR, {
        filename: ATTACHMENT_FILENAME,
        mimeType: 'image/png',
        value: ATTACHMENT_BASE64,
      })
      await control.command('waitFor', '[data-testid="attachment-badge"]', {
        timeoutMs: uiTimeoutMs,
      })
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
      assert.ok(
        JSON.stringify(targetRequest).includes(ATTACHMENT_FILENAME),
        'The real Codex request omitted the streaming attachment'
      )
      await control.command('waitFor', THINKING_INDICATOR_SELECTOR, {
        timeoutMs: uiTimeoutMs,
      })
      const waitingScrollerMetrics = await waitForBottom(
        control,
        'The conversation scroller while waiting for the assistant',
        uiTimeoutMs
      )
      const thinkingIndicatorMetrics = await getSingleElementMetrics(
        control,
        THINKING_INDICATOR_SELECTOR,
        'The thinking indicator after sending'
      )
      assertElementFullyVisible(
        thinkingIndicatorMetrics,
        waitingScrollerMetrics,
        'The thinking indicator after sending'
      )
      await control.command('markElementWithText', USER_MESSAGE_SELECTOR, {
        text: PROMPT,
        value: USER_MESSAGE_E2E_ID,
        timeoutMs: uiTimeoutMs,
      })
      const latestUserMessageMetrics = await getSingleElementMetrics(
        control,
        USER_MESSAGE_SELECTOR_MARKED,
        'The latest user message after sending'
      )
      const scrollerAfterSend = await getSingleElementMetrics(
        control,
        SCROLLER_SELECTOR,
        'The conversation scroller after sending'
      )
      assertElementFullyVisible(
        latestUserMessageMetrics,
        scrollerAfterSend,
        'The latest user message after sending'
      )
      releaseStart()
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
        text: MARKER,
        stableMs: 750,
        timeoutMs: uiTimeoutMs,
      })
      await waitForBottom(
        control,
        'The conversation scroller while the assistant response starts',
        uiTimeoutMs
      )
      const streamingSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.ok(
        streamingSnapshot.text.includes(MARKER),
        'The assistant text after the streaming tool call lost its prefix'
      )
      assert.ok(
        streamingSnapshot.testIds.includes('assistant-message-content'),
        'The phase-less streaming response was not rendered as assistant content'
      )
      assert.ok(
        !streamingSnapshot.text.includes(APPEND_MARKER),
        'The later assistant delta was visible before the runtime released it'
      )
      await control.command('scrollToRatioAsUser', SCROLLER_SELECTOR, { value: '0.18' })
      await control.command('waitFor', VIEWPORT_ANCHOR_SCOPE_SELECTOR, {
        text: VIEWPORT_ANCHOR_TEXT,
        stableMs: 750,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('markElementWithText', VIEWPORT_ANCHOR_SCOPE_SELECTOR, {
        text: VIEWPORT_ANCHOR_TEXT,
        value: VIEWPORT_ANCHOR_E2E_ID,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getText', VIEWPORT_ANCHOR_SELECTOR),
        VIEWPORT_ANCHOR_TEXT,
        'The viewport anchor paragraph was not rendered at the expected position'
      )
      const userScrollPosition = await getSingleElementMetrics(
        control,
        SCROLLER_SELECTOR,
        'The streaming conversation immediately after the user scrolled upward'
      )
      assert.ok(
        distanceFromBottom(userScrollPosition) > 8,
        'The simulated user scroll did not move the streaming conversation away from the bottom'
      )
      await new Promise(resolve => setTimeout(resolve, 750))
      const stableUserScrollPosition = await getSingleElementMetrics(
        control,
        SCROLLER_SELECTOR,
        'The streaming conversation after pending bottom restores had time to run'
      )
      assert.ok(
        Math.abs(stableUserScrollPosition.scrollTop - userScrollPosition.scrollTop) <= 8,
        `The streaming conversation jumped from ${userScrollPosition.scrollTop}px to ${stableUserScrollPosition.scrollTop}px after the user scrolled upward`
      )

      await control.command('scrollIntoViewAsUser', VIEWPORT_ANCHOR_SELECTOR)
      await new Promise(resolve => setTimeout(resolve, 250))
      const scrollerBeforeAppend = await getSingleElementMetrics(
        control,
        SCROLLER_SELECTOR,
        'The streaming conversation scroller before later content'
      )
      assert.ok(
        distanceFromBottom(scrollerBeforeAppend) > 8,
        'The simulated user scroll did not move the streaming conversation away from the bottom'
      )
      const anchorBeforeAppend = await getSingleElementMetrics(
        control,
        VIEWPORT_ANCHOR_SELECTOR,
        'The viewport anchor before later content'
      )
      assert.ok(
        anchorBeforeAppend.top >= scrollerBeforeAppend.top &&
          anchorBeforeAppend.bottom <= scrollerBeforeAppend.bottom,
        `The viewport anchor was not visible after the user scroll (top=${anchorBeforeAppend.top}px, bottom=${anchorBeforeAppend.bottom}px)`
      )
      await capture(control, 'streaming-text-11-user-scrolled-up.png')

      releaseAppend()
      const scrollerAfterAppend = await waitForScrollHeightIncrease(
        control,
        scrollerBeforeAppend.scrollHeight,
        'The virtualized streaming conversation after later content',
        uiTimeoutMs
      )
      await new Promise(resolve => setTimeout(resolve, 750))
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
      await capture(control, 'streaming-text-12-anchor-stable-after-append.png')

      await control.command('scrollToBottomAsUser', SCROLLER_SELECTOR)
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
        text: APPEND_MARKER,
        stableMs: 750,
        timeoutMs: uiTimeoutMs,
      })
      const pinnedBeforeSwitch = await waitForBottom(
        control,
        'The streaming conversation before switching tasks',
        5_000
      )
      assert.ok(
        distanceFromBottom(pinnedBeforeSwitch) <= 8,
        `The streaming conversation was ${distanceFromBottom(pinnedBeforeSwitch)}px from the bottom before switching tasks`
      )
      await new Promise(resolve => setTimeout(resolve, 250))
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
        text: MARKER,
        stableMs: 750,
        timeoutMs: uiTimeoutMs,
      })
      const pinnedAfterSwitch = await waitForBottom(
        control,
        'The bottom-pinned streaming conversation after switching back',
        5_000
      )
      assert.ok(
        distanceFromBottom(pinnedAfterSwitch) <= 8,
        `The bottom-pinned streaming conversation reopened ${distanceFromBottom(pinnedAfterSwitch)}px from the bottom`
      )
      await capture(control, 'streaming-text-13-bottom-restored-after-task-switch.png')

      for (let index = 0; index < PANE_EVICTION_BLANK_COUNT; index += 1) {
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      }
      await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
        text: MARKER,
        stableMs: 750,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(await control.command('getElementCount', TURN_NAVIGATION_MARKER_SELECTOR)),
        HISTORY_TURNS.length + 2,
        'The remounted running conversation lost or duplicated earlier user turns'
      )
      await control.command('hover', `${TURN_NAVIGATION_MARKER_SELECTOR}[data-turn-index="0"]`)
      const initialTurnPreview = await control.command(
        'getText',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-preview"][data-turn-index="0"]`
      )
      assert.ok(
        initialTurnPreview.includes(INITIAL_PROMPT),
        'The remounted running conversation lost the previous user question'
      )
      assert.ok(
        initialTurnPreview.includes('WEWORK_DESKTOP_E2E_STREAMING_TEXT_INITIAL_COMPLETE'),
        'The remounted running conversation lost the previous assistant answer'
      )
      await control.command(
        'hover',
        `${TURN_NAVIGATION_MARKER_SELECTOR}[data-turn-index="${STREAMING_TURN_INDEX}"]`
      )
      const streamingTurnPreview = await control.command(
        'getText',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-preview"][data-turn-index="${STREAMING_TURN_INDEX}"]`
      )
      assert.ok(
        streamingTurnPreview.includes('WEWORK_DESKTOP_E2E_STREAMING_TEXT'),
        'The streaming turn preview did not show the visible user input'
      )
      assert.ok(
        !streamingTurnPreview.includes('Files mentioned by the user'),
        'The streaming turn preview exposed the internal attachment wrapper'
      )
      assert.ok(
        !streamingTurnPreview.includes('application_context'),
        'The streaming turn preview exposed injected application context'
      )
      await capture(control, 'streaming-text-14-thinking-below-partial-response.png')

      releaseResponse()
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
        { stableMs: 750, timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
        text: MARKER,
        stableMs: 750,
        timeoutMs: uiTimeoutMs,
      })
      const completedSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.ok(
        completedSnapshot.text.includes(MARKER),
        'The completed response lost its streamed text'
      )
      assert.ok(
        completedSnapshot.testIds.includes('assistant-message-content'),
        'The completed response was not retained as assistant content'
      )
      assert.ok(
        !completedSnapshot.testIds.includes('thinking-indicator'),
        'The thinking indicator remained after completion'
      )
      assert.ok(
        !completedSnapshot.testIds.includes('pause-response-button'),
        'The pause button remained after completion'
      )
      await capture(control, 'streaming-text-15-response-completed.png')
      await verifyStoppedTurnOrder(control)
      active = false
    },

    diagnostics() {
      return { receivedTargetRequest: Boolean(targetRequest) }
    },
  }
}
