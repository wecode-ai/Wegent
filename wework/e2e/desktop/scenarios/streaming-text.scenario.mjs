import assert from 'node:assert/strict'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const TOOL_REGRESSION_PROMPT = 'WEWORK_DESKTOP_E2E_TOOL_TEXT_OFFSET'
const TOOL_PREAMBLE = '找到了关键错误。看一下失败前后的上下文：'
const TOOL_COMPLETION = '本地分支落后于 main，CI 跑的提交是 719f99694。'
const HIDDEN_REASONING = 'WEWORK_DESKTOP_E2E_HIDDEN_REASONING_CONTENT'
const INITIAL_PROMPT = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_INITIAL'
const INITIAL_COMPLETION = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_INITIAL_COMPLETE'
const PROMPT = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT: keep the partial response active until released.'
const MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_PARTIAL'
const VIEWPORT_MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_VIEWPORT_ANCHOR'
const APPEND_MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_APPENDED'
const ATTACHMENT_FILENAME = 'streaming-turn-navigation.png'
const ATTACHMENT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC'
const TURN_NAVIGATION_MARKER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-marker"]`
const SCROLLER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`
const VIEWPORT_ANCHOR_TEXT = `${VIEWPORT_MARKER}: this paragraph must remain fixed after the user scrolls upward.`
const VIEWPORT_ANCHOR_E2E_ID = 'streaming-text-viewport-anchor'
const VIEWPORT_ANCHOR_SCOPE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"] [data-scroll-anchor]`
const VIEWPORT_ANCHOR_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-e2e-anchor-id="${VIEWPORT_ANCHOR_E2E_ID}"]`
const INITIAL_PARAGRAPHS = Array.from({ length: 28 }, (_, index) => {
  if (index === 11) {
    return VIEWPORT_ANCHOR_TEXT
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

function requestContainsToolRegressionPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(TOOL_REGRESSION_PROMPT)
}

function requestContainsToolOutput(body) {
  return JSON.stringify(body.input ?? []).includes('function_call_output')
}

function selectShellTool(body, workspacePath) {
  const tools = Array.isArray(body.tools) ? body.tools : []
  const names = new Set(tools.map(tool => tool?.name).filter(Boolean))
  if (names.has('exec_command')) {
    return {
      name: 'exec_command',
      arguments: {
        cmd: 'pwd',
        workdir: workspacePath,
        yield_time_ms: 1_000,
      },
    }
  }
  assert.ok(names.has('shell_command'), `Real Codex did not advertise a shell tool: ${[...names]}`)
  return {
    name: 'shell_command',
    arguments: {
      command: 'pwd',
      workdir: workspacePath,
      timeout_ms: 1_000,
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
    async handleHttp(request, response, url) {
      if (!active) return false
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname)) {
        return false
      }

      const body = await readJson(request)
      const responseId = `wework-streaming-text-${Date.now()}`
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

      if (requestContainsPrompt(body)) {
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
      }

      if (requestContainsToolRegressionPrompt(body)) {
        if (toolRegressionStage === 'initial') {
          const tool = selectShellTool(body, workspacePath)
          toolRegressionStage = 'awaiting-tool-output'
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
          response.end(
            sse([
              responseCreated(responseId),
              ...reasoningEvents('wework-hidden-reasoning', HIDDEN_REASONING),
              assistantMessage(TOOL_PREAMBLE),
              ...functionCall('wework-tool-text-offset', tool.name, tool.arguments),
              responseCompleted(responseId),
            ])
          )
          return true
        }
        throw new Error(`Unexpected tool-text-offset stage: ${toolRegressionStage}`)
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
        toolRegressionSnapshot.text.includes(HIDDEN_REASONING),
        false,
        'The model reasoning content remained visible after completion'
      )
      assert.equal(
        toolRegressionSnapshot.text.includes('思考过程'),
        false,
        'The completed response still rendered a reasoning disclosure'
      )
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
        text: INITIAL_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      const taskRowTestId = await waitForNewTaskRow(
        control,
        knownTaskRows,
        INITIAL_PROMPT,
        uiTimeoutMs
      )
      await capture(control, 'streaming-text-00-ready-to-send.png')
      const finalContentCountBeforeStreaming = Number(
        await control.command(
          'getElementCount',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`
        )
      )
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
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"]`,
        { text: MARKER, stableMs: 750, timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"]`,
        { text: VIEWPORT_MARKER, stableMs: 750, timeoutMs: uiTimeoutMs }
      )
      const streamingSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.ok(
        streamingSnapshot.text.includes(MARKER),
        'The process text after the streaming tool call lost its prefix'
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`
          )
        ),
        finalContentCountBeforeStreaming,
        'Ambiguous streaming text was rendered as final assistant content'
      )
      await control.command('scrollToBottomAsUser', SCROLLER_SELECTOR)
      const pinnedBeforeSwitch = await waitForBottom(
        control,
        'The streaming conversation before switching tasks',
        5_000
      )
      assert.ok(
        distanceFromBottom(pinnedBeforeSwitch) <= 8,
        `The streaming conversation was ${distanceFromBottom(pinnedBeforeSwitch)}px from the bottom before switching tasks`
      )
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"]`,
        { text: MARKER, stableMs: 750, timeoutMs: uiTimeoutMs }
      )
      await new Promise(resolve => setTimeout(resolve, 1_500))
      const pinnedAfterSwitch = await getSingleElementMetrics(
        control,
        SCROLLER_SELECTOR,
        'The bottom-pinned streaming conversation after switching back'
      )
      assert.ok(
        distanceFromBottom(pinnedAfterSwitch) <= 8,
        `The bottom-pinned streaming conversation reopened ${distanceFromBottom(pinnedAfterSwitch)}px from the bottom`
      )
      await capture(control, 'streaming-text-01-bottom-restored-after-task-switch.png')
      assert.equal(
        Number(await control.command('getElementCount', TURN_NAVIGATION_MARKER_SELECTOR)),
        2,
        'Two user turns were rendered with duplicate turn-navigation markers'
      )
      await control.command('hover', `${TURN_NAVIGATION_MARKER_SELECTOR}[data-turn-index="1"]`)
      const streamingTurnPreview = await control.command(
        'getText',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-preview"][data-turn-index="1"]`
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
      await capture(control, 'streaming-text-02-thinking-below-partial-response.png')

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
      await control.command('scrollToRatioAsUser', SCROLLER_SELECTOR, { value: '0.35' })
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

      await control.command('scrollIntoView', VIEWPORT_ANCHOR_SELECTOR)
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
      await capture(control, 'streaming-text-03-user-scrolled-up.png')

      releaseAppend()
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"]`,
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
      await capture(control, 'streaming-text-04-anchor-stable-after-append.png')

      releaseResponse()
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
        { stableMs: 750, timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`,
        { text: MARKER, stableMs: 750, timeoutMs: uiTimeoutMs }
      )
      const completedSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.ok(
        completedSnapshot.text.includes(MARKER),
        'The completed response lost its streamed text'
      )
      assert.ok(
        completedSnapshot.testIds.includes('assistant-message-content'),
        'The completed response did not promote ambiguous text to final assistant content'
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`
          )
        ),
        finalContentCountBeforeStreaming + 1,
        'Turn completion did not add exactly one final assistant content block'
      )
      assert.ok(
        !completedSnapshot.testIds.includes('thinking-indicator'),
        'The thinking indicator remained after completion'
      )
      assert.ok(
        !completedSnapshot.testIds.includes('pause-response-button'),
        'The pause button remained after completion'
      )
      await capture(control, 'streaming-text-05-response-completed.png')
      active = false
    },

    diagnostics() {
      return { receivedTargetRequest: Boolean(targetRequest) }
    },
  }
}
