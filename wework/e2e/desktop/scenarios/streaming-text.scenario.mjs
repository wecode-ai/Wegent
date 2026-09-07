import assert from 'node:assert/strict'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, selectE2EModel } from '../modules/shared.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const TOOL_REGRESSION_PROMPT = 'WEWORK_DESKTOP_E2E_TOOL_TEXT_OFFSET'
const TOOL_PREAMBLE = '找到了关键错误。看一下失败前后的上下文：'
const TOOL_COMPLETION = '本地分支落后于 main，CI 跑的提交是 719f99694。'
const LEGACY_CONVERSATION_PROMPT = 'WEWORK_DESKTOP_E2E_LEGACY_CONVERSATION_INITIAL'
const LEGACY_CONVERSATION_COMPLETION = 'WEWORK_DESKTOP_E2E_LEGACY_CONVERSATION_COMPLETE'
const LEGACY_TRANSCRIPT_ITEM_ID = 'wework-desktop-e2e-legacy-assistant-text'
const LONG_CODE_PROMPT = 'WEWORK_DESKTOP_E2E_LONG_CODE_TERMINAL_BURST'
const LONG_CODE_STREAM_MARKER = 'WEWORK_DESKTOP_E2E_LONG_CODE_LINE_055'
const LONG_CODE_MARKER = 'WEWORK_DESKTOP_E2E_LONG_CODE_LINE_110'
const LONG_CODE_COMPLETION = [
  'The completed response contains one long SQL block and a windowed Markdown tail.',
  '',
  '```sql',
  ...Array.from({ length: 110 }, (_, index) => {
    const line = index + 1
    return `SELECT ${line} AS value_${line}, 'customer_${String(line).padStart(
      3,
      '0'
    )}' AS customer_name, JSON_OBJECT('id', ${line}, 'status', 'active', 'description', 'streaming long code row ${line}') AS payload${
      index === 54 ? `, '${LONG_CODE_STREAM_MARKER}' AS stream_marker` : ''
    }${index === 109 ? `, '${LONG_CODE_MARKER}' AS marker` : ''} FROM generated_records WHERE record_id = ${line};`
  }),
  '```',
  '',
  ...Array.from(
    { length: 24 },
    (_, index) =>
      `### Rapid scroll section ${index + 1}\n\n${`Visible fallback content ${index + 1} keeps the conversation painted during rapid scrolling. `.repeat(18)}`
  ),
].join('\n')
const LONG_CODE_REASONING = Array.from(
  { length: 180 },
  (_, index) => `Completed reasoning line ${index + 1} for the terminal rendering burst.`
).join('\n')
const VISUALIZATION_PROMPT = 'WEWORK_DESKTOP_E2E_ABSOLUTE_VISUALIZATION'
const VISUALIZATION_TITLE = 'Absolute visualization E2E'
const VISUALIZATION_MARKER = 'WEWORK_DESKTOP_E2E_VISUALIZATION_VISIBLE'
const GENERATED_IMAGE_PROMPT = 'WEWORK_DESKTOP_E2E_GENERATED_IMAGE'
const GENERATED_IMAGE_COMPLETION = 'WEWORK_DESKTOP_E2E_GENERATED_IMAGE_COMPLETE'
const GENERATED_IMAGE_CALL_ID = 'wework-generated-image'
const GENERATED_IMAGE_REVISED_PROMPT = 'A small generated image used by the desktop regression test'
const WINDOWS_LINK_PROMPT = 'WEWORK_DESKTOP_E2E_WINDOWS_DRIVE_LINK'
const WINDOWS_LINK_LABEL = 'wegent'
const WINDOWS_LINK_COMPLETION = '[wegent](C:/projects/example-app/wegent)'
const PHASE_FLIP_PROMPT = 'WEWORK_DESKTOP_E2E_PROCESS_TO_FALLBACK_FINAL'
const PHASE_FLIP_TEXT = 'WEWORK_DESKTOP_E2E_FALLBACK_FINAL_FROM_PROCESS'
const TIMER_PROMPT = 'WEWORK_DESKTOP_E2E_RUNNING_TIMER_PERSISTS'
const TIMER_COMPLETION = 'WEWORK_DESKTOP_E2E_RUNNING_TIMER_COMPLETE'
const ORDER_STOP_PROMPT = 'WEWORK_DESKTOP_E2E_ORDER_STOPPED_TURN'
const ORDER_STOP_PARTIAL = 'WEWORK_DESKTOP_E2E_ORDER_STOP_PARTIAL'
const ORDER_FOLLOW_UP_PREFIX = 'WEWORK_DESKTOP_E2E_ORDER_FOLLOW_UP'
const ORDER_COMPLETION_PREFIX = 'WEWORK_DESKTOP_E2E_ORDER_COMPLETION'
const ORDER_FOLLOW_UP_COUNT = 26
const HIDDEN_REASONING = 'WEWORK_DESKTOP_E2E_HIDDEN_REASONING_CONTENT'
const REASONING_SUMMARY = 'WEWORK_DESKTOP_E2E_REASONING_SUMMARY'
const REASONING_PREVIEW = REASONING_SUMMARY.replaceAll('_', ' ')
const INITIAL_PROMPT = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_INITIAL'
const HISTORY_PROMPT_PREFIX = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_HISTORY'
const PROMPT = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT: keep the partial response active until released.'
const MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_PARTIAL'
const VIEWPORT_MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_VIEWPORT_ANCHOR'
const APPEND_MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_APPENDED'
const SCROLL_BUTTON_APPEND_MARKER = 'WEWORK_DESKTOP_E2E_SCROLL_BUTTON_APPEND'
const ATTACHMENT_FILENAME = 'streaming-turn-navigation.png'
const ATTACHMENT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC'
const TURN_NAVIGATION_MARKER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-marker"]`
const SCROLLER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`
const SCROLL_TO_BOTTOM_BUTTON_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="scroll-to-bottom-button"]`
const COMPOSER_CARD_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-floating-composer-card"]`
const ASSISTANT_CONTENT_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`
const ASSISTANT_MESSAGE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
const ASSISTANT_MARKDOWN_LINK_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-markdown-link"]`
const THINKING_INDICATOR_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="thinking-indicator"]`
const TOOL_THINKING_INDICATOR_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="tool-thinking-indicator"]`
const USER_MESSAGE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
const USER_MESSAGE_E2E_ID = 'streaming-text-latest-user-message'
const USER_MESSAGE_SELECTOR_MARKED = `${ACTIVE_WORKBENCH_SELECTOR} [data-e2e-anchor-id="${USER_MESSAGE_E2E_ID}"]`
const PROCESSING_SUMMARY_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="processing-summary-header"]`
const PROCESS_TEXT_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"]`
const LONG_CODE_SCROLL_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="markdown-code-scroll-container"]`
const LONG_CODE_E2E_ID = 'streaming-text-long-code'
const LONG_CODE_MARKED_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-e2e-anchor-id="${LONG_CODE_E2E_ID}"]`
const VIEWPORT_ANCHOR_TEXT = `${VIEWPORT_MARKER}: this paragraph must remain fixed after the user scrolls upward.`
const VIEWPORT_ANCHOR_E2E_ID = 'streaming-text-viewport-anchor'
const VIEWPORT_ANCHOR_SCOPE_SELECTOR = `${PROCESS_TEXT_SELECTOR} [data-scroll-anchor]`
const VIEWPORT_ANCHOR_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-e2e-anchor-id="${VIEWPORT_ANCHOR_E2E_ID}"]`
const HISTORY_PARAGRAPHS = Array.from(
  { length: 28 },
  (_, index) =>
    `Completed history paragraph ${index + 1}: this content belongs to the previous assistant turn.`
)
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
const INITIAL_PARAGRAPHS = Array.from({ length: 28 }, (_, index) =>
  index === 26
    ? VIEWPORT_ANCHOR_TEXT
    : `Initial streaming paragraph ${index + 1}: enough text keeps the response taller than the desktop chat viewport.`
)
const APPENDED_PARAGRAPHS = Array.from({ length: 14 }, (_, index) =>
  index === 0
    ? `${APPEND_MARKER}: later streamed content is now visible in the response.`
    : `Later streaming paragraph ${index + 1}: this content arrives after the user pauses automatic following.`
)
const PARTIAL_TEXT = `${MARKER}: response remains active while final checks continue. 中文流式内容不得重复。\n\n${INITIAL_PARAGRAPHS.join('\n\n')}`
const APPENDED_TEXT = `\n\n${APPENDED_PARAGRAPHS.join('\n\n')}`
const SCROLL_BUTTON_APPENDED_TEXT = `\n\n${Array.from({ length: 24 }, (_, index) =>
  index === 0
    ? `${SCROLL_BUTTON_APPEND_MARKER}: content keeps growing after the user clicks the jump-to-bottom button.`
    : `Scroll button growth paragraph ${index + 1}: the click must continue following the virtualized conversation bottom.`
).join('\n\n')}`

async function openNewChatWithE2EModel(control, timeoutMs) {
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, ACTIVE_WORKBENCH_SELECTOR)
}
const COMPLETION_TEXT = `${PARTIAL_TEXT}${APPENDED_TEXT}${SCROLL_BUTTON_APPENDED_TEXT}\n\nCOMPLETE`

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

function assistantMessage(text, phase) {
  const phaseFields = phase ? { phase } : {}
  return {
    type: 'response.output_item.done',
    item: {
      id: `wework-streaming-text-message-${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
      ...phaseFields,
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

function namespacedFunctionCall(callId, namespace, name, argumentsValue) {
  return functionCall(callId, name, argumentsValue).map(event => ({
    ...event,
    item: { ...event.item, namespace },
  }))
}

function reasoningEvents(itemId, text, deltaChunkSize = text.length) {
  const deltas = text.match(new RegExp(`[\\s\\S]{1,${deltaChunkSize}}`, 'g')) ?? []
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
    ...deltas.map(delta => ({
      type: 'response.reasoning_summary_text.delta',
      item_id: itemId,
      output_index: 0,
      summary_index: 0,
      delta,
    })),
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

function streamingEvents(id, completionText = COMPLETION_TEXT, phase = 'final_answer') {
  const itemId = `${id}-message`
  const phaseFields = phase ? { phase } : {}
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
          ...phaseFields,
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
        text: completionText,
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: itemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: completionText, annotations: [] }],
          ...phaseFields,
        },
      },
      responseCompleted(id),
    ],
  }
}

function phaseFlipEvents(id) {
  const itemId = `${id}-phase-flip-message`
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
    ...textDeltaEvents(itemId, PHASE_FLIP_TEXT),
    {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: PHASE_FLIP_TEXT,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: PHASE_FLIP_TEXT, annotations: [] }],
        phase: 'commentary',
      },
    },
    responseCompleted(id),
  ]
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

function requestContainsPhaseFlipPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(PHASE_FLIP_PROMPT)
}

function requestContainsLegacyConversationPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(LEGACY_CONVERSATION_PROMPT)
}

function requestContainsVisualizationPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(VISUALIZATION_PROMPT)
}

function requestContainsGeneratedImagePrompt(body) {
  return JSON.stringify(body.input ?? []).includes(GENERATED_IMAGE_PROMPT)
}

function requestContainsWindowsLinkPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(WINDOWS_LINK_PROMPT)
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

function requestContainsToolOutputForCall(body, callId) {
  return (Array.isArray(body.input) ? body.input : []).some(
    item => item?.type === 'function_call_output' && item.call_id === callId
  )
}

async function waitForRuntimePaneReadyToSend(control, timeoutMs) {
  const startedAt = Date.now()
  let lastStatus = null
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    lastStatus = snapshot.pane?.status ?? null
    if (lastStatus?.isBusy === false && lastStatus.canSendQueuedMessage === true) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`The runtime turn did not settle before follow-up: ${JSON.stringify(lastStatus)}`)
}

async function waitForRuntimeAssistantText(control, address, expectedText, timeoutMs) {
  const startedAt = Date.now()
  let latestText = ''
  while (Date.now() - startedAt < timeoutMs) {
    const runtimeMessages = JSON.parse(
      await control.command('getRuntimeConversationMessages', 'body', {
        value: JSON.stringify(address),
      })
    )
    latestText =
      runtimeMessages
        .filter(message => message.role === 'assistant')
        .flatMap(message => message.blocks ?? [])
        .filter(block => block.type === 'text')
        .at(-1)?.content ?? ''
    if (latestText === expectedText) return latestText
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(
    `The runtime conversation cache did not converge to the streamed text; received ${latestText.length} of ${expectedText.length} characters`
  )
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

function selectImageGenerationTool(body) {
  const tools = Array.isArray(body.tools) ? body.tools : []
  const namespace = tools.find(tool => tool?.type === 'namespace' && tool.name === 'image_gen')
  const tool = namespace?.tools?.find(
    candidate => candidate?.type === 'function' && candidate.name === 'imagegen'
  )
  if (tool) {
    return {
      namespace: namespace.name,
      name: tool.name,
      arguments: { prompt: GENERATED_IMAGE_REVISED_PROMPT },
    }
  }
  const flattenedTool = tools.find(
    candidate =>
      candidate?.type === 'function' &&
      (candidate.name === 'image_gen__imagegen' || candidate.name === 'image_genimagegen')
  )
  assert.ok(
    flattenedTool,
    `Real Codex did not advertise image_gen.imagegen: ${tools
      .map(candidate => `${candidate?.type ?? 'unknown'}:${candidate?.name ?? 'unnamed'}`)
      .join(', ')}`
  )
  return {
    namespace: null,
    name: flattenedTool.name,
    arguments: { prompt: GENERATED_IMAGE_REVISED_PROMPT },
  }
}

async function getSingleElementMetrics(control, selector, description) {
  const metrics = JSON.parse(await control.command('getElementMetrics', selector))
  assert.equal(metrics.length, 1, `${description} matched ${metrics.length} elements`)
  return metrics[0]
}

function distanceFromBottom(metrics) {
  if (metrics.scrollOrigin === 'bottom') {
    return Math.max(0, -metrics.scrollTop)
  }
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop)
}

function distanceFromTop(metrics) {
  if (metrics.scrollOrigin === 'bottom') {
    return Math.max(0, metrics.scrollHeight - metrics.clientHeight + metrics.scrollTop)
  }
  return Math.max(0, metrics.scrollTop)
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

async function assertComposerDocked(control, scrollerMetrics, description) {
  const composerMetrics = await getSingleElementMetrics(
    control,
    COMPOSER_CARD_SELECTOR,
    description
  )
  assertElementFullyVisible(composerMetrics, scrollerMetrics, description)
  const bottomGap = scrollerMetrics.bottom - composerMetrics.bottom
  assert.ok(
    bottomGap >= 0 && bottomGap <= 32,
    `${description} drifted ${bottomGap}px above the conversation viewport bottom`
  )
}

async function waitForToolDuration(control, minimumSeconds, timeoutMs) {
  const selector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="tool-block-duration"]`
  const deadline = Date.now() + timeoutMs
  await control.command('waitFor', selector, { timeoutMs })
  await new Promise(resolve =>
    setTimeout(resolve, Math.min(minimumSeconds * 1_000, Math.max(0, deadline - Date.now())))
  )
  let text = ''
  let duration = 0
  while (Date.now() <= deadline) {
    text = await control.command('getText', selector)
    duration = toolDurationSeconds(text)
    if (duration >= minimumSeconds) return duration
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    await new Promise(resolve => setTimeout(resolve, Math.min(500, remainingMs)))
  }
  assert.ok(
    duration >= minimumSeconds,
    `The running tool duration did not reach ${minimumSeconds}s; latest row: ${text}`
  )
  return duration
}

async function expandCompletedProcessing(control, timeoutMs) {
  const finalToggle = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="final-processing-toggle"]`
  await control.command('waitFor', finalToggle, { timeoutMs })
  if ((await control.command('getAttribute', finalToggle, { value: 'aria-expanded' })) !== 'true') {
    await control.command('click', finalToggle)
  }
  const summaryToggle = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="processing-summary-toggle"]`
  await control.command('waitFor', summaryToggle, { timeoutMs })
  if (
    (await control.command('getAttribute', summaryToggle, { value: 'aria-expanded' })) !== 'true'
  ) {
    await control.command('click', summaryToggle)
  }
}

async function completedToolDuration(control, timeoutMs) {
  const selector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="tool-block-duration"]`
  await expandCompletedProcessing(control, timeoutMs)
  await control.command('waitFor', selector, { timeoutMs })
  const text = await control.command('getText', selector)
  const duration = toolDurationSeconds(text)
  assert.ok(duration > 0, `The completed tool duration was missing: ${text}`)
  return duration
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

async function assertScrollPositionRemainsStable(control, initialMetrics, description, timeoutMs) {
  const startedAt = Date.now()
  const initialDistanceFromTop = distanceFromTop(initialMetrics)
  while (Date.now() - startedAt < timeoutMs) {
    const metrics = await getSingleElementMetrics(control, SCROLLER_SELECTOR, description)
    assert.ok(
      distanceFromBottom(metrics) > 8,
      `${description} returned to the bottom after the user scrolled upward`
    )
    assert.ok(
      Math.abs(distanceFromTop(metrics) - initialDistanceFromTop) <= 8,
      `${description} jumped from ${initialDistanceFromTop}px to ${distanceFromTop(metrics)}px from the content top`
    )
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function waitForRenderedAppend(control, previousContentLength, timeoutMs) {
  const startedAt = Date.now()
  let processText = ''
  while (Date.now() - startedAt < timeoutMs) {
    processText = await control.command('getText', PROCESS_TEXT_SELECTOR)
    if (processText.length > previousContentLength) {
      return getSingleElementMetrics(
        control,
        SCROLLER_SELECTOR,
        'The virtualized streaming conversation after the append rendered'
      )
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(
    `The rendered streaming append did not increase process text from ${previousContentLength} characters; latest text: ${processText}`
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

async function waitForVisualizationBlob(control, selector, timeoutMs) {
  const startedAt = Date.now()
  let source = ''
  while (Date.now() - startedAt < timeoutMs) {
    source = await control.command('getAttribute', selector, { value: 'src' })
    if (source.startsWith('blob:')) return source
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`The absolute visualization did not load through the asset protocol: ${source}`)
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

async function retainSecondTaskWorkspace(control, timeoutMs) {
  const activeTabId = await control.command(
    'getAttribute',
    '[data-workspace-tab-content][aria-hidden="false"]',
    { value: 'data-workspace-tab-content' }
  )
  assert.ok(activeTabId, 'The active task workspace tab identity was not observable')
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', { timeoutMs })
  await control.command('click', '[data-testid="workspace-tab-add-task"]')
  const startedAt = Date.now()
  let secondTabId = ''
  while (Date.now() - startedAt < timeoutMs) {
    secondTabId = await control.command(
      'getAttribute',
      '[data-workspace-tab-content][aria-hidden="false"]',
      { value: 'data-workspace-tab-content' }
    )
    if (secondTabId && secondTabId !== activeTabId) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(
    secondTabId && secondTabId !== activeTabId,
    'The second task workspace tab was not created'
  )
  const secondWorkbenchSelector =
    `[data-workspace-tab-content="${secondTabId}"] ` + '[data-testid="desktop-workbench-main"]'
  await control.command('waitFor', secondWorkbenchSelector, { timeoutMs })
  await control.command(
    'waitFor',
    `${secondWorkbenchSelector} [data-testid="chat-message-input"]`,
    {
      timeoutMs,
    }
  )
  await control.command('click', `[data-testid="workspace-tab-select-${activeTabId}"]`)
  await control.command(
    'waitFor',
    `[data-workspace-tab-content="${activeTabId}"] ${COMPOSER_SELECTOR}`,
    { timeoutMs }
  )
  assert.ok(
    Number(
      await control.command(
        'getElementCount',
        '[data-workspace-tab-content] [data-testid="desktop-workbench-surface"]'
      )
    ) >= 2,
    'The inactive task workspace provider was not retained for the streaming regression'
  )
}

export function createDesktopScenario({
  captureScreenshot,
  standalone,
  uiTimeoutMs,
  workspacePath,
}) {
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)
  let active = false
  let generatedImageStage = 'initial'
  let toolRegressionStage = 'initial'
  let timerStage = 'initial'
  let releaseAppend
  let releaseLongCodeStream
  let releasePhaseFlipCompletion
  let releaseResponse
  let releaseScrollButtonAppend
  let releaseStart
  let releaseToolCompletion
  let releaseToolFinalCompletion
  let resolveAppendWritten
  let resolvePartialWritten
  let resolveRequest
  let resolveScrollButtonAppendWritten
  let resolveToolFinalTextStarted
  let resolveToolFollowUp
  let targetRequest
  const appendRelease = new Promise(resolve => {
    releaseAppend = resolve
  })
  const longCodeStreamRelease = new Promise(resolve => {
    releaseLongCodeStream = resolve
  })
  const phaseFlipCompletionRelease = new Promise(resolve => {
    releasePhaseFlipCompletion = resolve
  })
  const responseRelease = new Promise(resolve => {
    releaseResponse = resolve
  })
  const scrollButtonAppendRelease = new Promise(resolve => {
    releaseScrollButtonAppend = resolve
  })
  const startRelease = new Promise(resolve => {
    releaseStart = resolve
  })
  const appendWritten = new Promise(resolve => {
    resolveAppendWritten = resolve
  })
  const partialWritten = new Promise(resolve => {
    resolvePartialWritten = resolve
  })
  const scrollButtonAppendWritten = new Promise(resolve => {
    resolveScrollButtonAppendWritten = resolve
  })
  const requestReceived = new Promise(resolve => {
    resolveRequest = resolve
  })
  const toolCompletionRelease = new Promise(resolve => {
    releaseToolCompletion = resolve
  })
  const toolFollowUpReceived = new Promise(resolve => {
    resolveToolFollowUp = resolve
  })
  const toolFinalTextStarted = new Promise(resolve => {
    resolveToolFinalTextStarted = resolve
  })
  const toolFinalCompletionRelease = new Promise(resolve => {
    releaseToolFinalCompletion = resolve
  })

  const verifyLongCodeTerminalBurst = async control => {
    await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
    await openNewChatWithE2EModel(control, uiTimeoutMs)
    await control.command('fill', COMPOSER_SELECTOR, { value: LONG_CODE_PROMPT })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: LONG_CODE_STREAM_MARKER,
      stableMs: 250,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('markElementWithText', `${LONG_CODE_SCROLL_SELECTOR} code`, {
      text: LONG_CODE_STREAM_MARKER,
      value: LONG_CODE_E2E_ID,
      timeoutMs: uiTimeoutMs,
    })
    const streamingClass = await control.command('getAttribute', LONG_CODE_SCROLL_SELECTOR, {
      value: 'class',
    })
    assert.match(
      streamingClass,
      /\bscrollbar-none\b/,
      'The native horizontal scrollbar remained visible while long code streamed'
    )
    assert.equal(
      Number(await control.command('getElementCount', THINKING_INDICATOR_SELECTOR)),
      0,
      'The generic thinking indicator remained after long-code output became visible'
    )

    releaseLongCodeStream()
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: LONG_CODE_MARKER,
      stableMs: 500,
      timeoutMs: uiTimeoutMs,
    })
    await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
    assert.equal(
      Number(await control.command('getElementCount', LONG_CODE_MARKED_SELECTOR)),
      1,
      'The long code DOM was replaced while more lines streamed'
    )

    let syntaxHighlighted = 'false'
    const highlightDeadline = Date.now() + uiTimeoutMs
    while (Date.now() < highlightDeadline) {
      syntaxHighlighted = await control.command('getAttribute', LONG_CODE_SCROLL_SELECTOR, {
        value: 'data-syntax-highlighted',
      })
      if (syntaxHighlighted === 'true') break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(
      syntaxHighlighted,
      'true',
      'The completed long code block did not receive syntax highlighting'
    )
    assert.ok(
      Number(
        await control.command('getElementCount', `${LONG_CODE_SCROLL_SELECTOR} .hljs-keyword`)
      ) > 0,
      'The completed long code block did not render highlighted keyword nodes'
    )
    const completedClass = await control.command('getAttribute', LONG_CODE_SCROLL_SELECTOR, {
      value: 'class',
    })
    assert.doesNotMatch(
      completedClass,
      /\bscrollbar-none\b/,
      'The completed long code block kept its horizontal scrollbar hidden'
    )
    assert.match(
      completedClass,
      /\bscrollbar-soft\b/,
      'The completed long code block did not restore its horizontal scrollbar'
    )
    await waitForBottom(control, 'The terminal-burst long-code conversation', uiTimeoutMs)
    const rapidScrollSamples = JSON.parse(
      await control.command('sampleRapidScrollContent', SCROLLER_SELECTOR, {
        value: JSON.stringify({
          contentSelector: '[data-markdown-window-chunk] > *',
          ratios: [0.75, 0.5, 0.25],
        }),
      })
    )
    assert.equal(
      rapidScrollSamples.every(sample => sample.hasVisibleContent),
      true,
      `Rapid scrolling exposed an empty Markdown viewport: ${JSON.stringify(rapidScrollSamples)}`
    )
    await capture(control, 'streaming-text-00-long-code-terminal-burst.png')
  }

  const verifyWindowsDriveLinkRendering = async control => {
    await openNewChatWithE2EModel(control, uiTimeoutMs)
    await control.command('fill', COMPOSER_SELECTOR, { value: WINDOWS_LINK_PROMPT })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    await control.command('waitFor', ASSISTANT_MARKDOWN_LINK_SELECTOR, {
      text: WINDOWS_LINK_LABEL,
      timeoutMs: uiTimeoutMs,
    })
    const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
    assert.ok(
      !snapshot.text.includes('[blocked]'),
      'The Windows drive-letter markdown link was rendered as blocked text'
    )
    await capture(control, 'streaming-text-00-windows-drive-link.png')
  }

  const verifyStoppedTurnOrder = async control => {
    await openNewChatWithE2EModel(control, uiTimeoutMs)
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
    await control.command('waitFor', ASSISTANT_MESSAGE_SELECTOR, {
      text: ORDER_STOP_PARTIAL,
      stableMs: 500,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="pause-response-button"]')
    await control.command('waitFor', '[data-testid="assistant-stopped-notice"]', {
      timeoutMs: uiTimeoutMs,
    })
    await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
    for (let index = 1; index <= ORDER_FOLLOW_UP_COUNT; index += 1) {
      const prompt = `${ORDER_FOLLOW_UP_PREFIX}_${index}`
      const completion = `${ORDER_COMPLETION_PREFIX}_${index}`
      await control.command('fill', COMPOSER_SELECTOR, { value: prompt })
      await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
        timeoutMs: uiTimeoutMs,
      })
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
    await capture(control, 'streaming-text-17-stopped-turn-order-restored.png')
  }

  return {
    modelProviderAuthToml: '',
    modelProviderConfigToml:
      'http_headers = { Authorization = "Bearer wework-e2e-test-key", "x-openai-actor-authorization" = "wework-desktop-e2e" }\n',
    appEnvironment: {
      WEWORK_E2E_SEED_LOCAL_MODELS: 'false',
    },

    async handleHttp(request, response, url) {
      if (!active) return false
      if (
        request.method === 'POST' &&
        ['/v1/images/generations', '/images/generations'].includes(url.pathname)
      ) {
        assert.equal(
          generatedImageStage,
          'awaiting-image-api',
          `Unexpected generated-image API stage: ${generatedImageStage}`
        )
        const body = await readJson(request)
        assert.equal(body.prompt, GENERATED_IMAGE_REVISED_PROMPT)
        assert.equal(body.model, 'gpt-image-2')
        generatedImageStage = 'awaiting-tool-output'
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: ATTACHMENT_BASE64 }],
          })
        )
        return true
      }
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname)) {
        return false
      }

      const body = await readJson(request)
      const responseId = `wework-streaming-text-${Date.now()}`
      const latestInput = latestModelInputText(body)
      const followUpNumber = orderFollowUpNumber(body)
      if (
        generatedImageStage === 'awaiting-tool-output' &&
        requestContainsToolOutputForCall(body, GENERATED_IMAGE_CALL_ID)
      ) {
        generatedImageStage = 'complete'
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(GENERATED_IMAGE_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
      }
      if (latestInput.includes(LONG_CODE_PROMPT)) {
        const stream = streamingEvents(responseId, LONG_CODE_COMPLETION, 'final_answer')
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.flushHeaders()
        response.write(
          sse([
            ...stream.start.slice(0, 1),
            ...reasoningEvents('wework-long-code-reasoning', LONG_CODE_REASONING, 4),
            ...stream.start.slice(1),
          ])
        )
        let offset = 0
        let streamedText = ''
        let streamHeld = false
        const codeEnd = LONG_CODE_COMPLETION.indexOf('\n```\n\n')
        assert.ok(codeEnd >= 0, 'The long-code fixture is missing its closing fence')
        const streamedCode = LONG_CODE_COMPLETION.slice(0, codeEnd + '\n```'.length)
        const windowedTail = LONG_CODE_COMPLETION.slice(streamedCode.length)
        for (const chunk of streamedCode.match(/[\s\S]{1,48}/g) ?? []) {
          response.write(sse(textDeltaEvents(stream.itemId, chunk, offset)))
          response.flush?.()
          offset += [...chunk].length
          streamedText += chunk
          if (!streamHeld && streamedText.includes(LONG_CODE_STREAM_MARKER)) {
            streamHeld = true
            await longCodeStreamRelease
          }
          await new Promise(resolve => setTimeout(resolve, 16))
        }
        response.write(sse(textDeltaEvents(stream.itemId, windowedTail, offset)))
        response.end(sse(stream.finish))
        return true
      }
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
      if (latestInput.includes(ORDER_STOP_PROMPT)) {
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.flushHeaders()
        response.write(sse([responseCreated(responseId), assistantMessage(ORDER_STOP_PARTIAL)]))
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
        toolRegressionStage = 'awaiting-completion-release'
        resolveToolFollowUp()
        await toolCompletionRelease
        const stream = streamingEvents(responseId, TOOL_COMPLETION, null)
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.flushHeaders()
        response.write(sse(stream.start))
        await writeSseEvents(response, textDeltaEvents(stream.itemId, TOOL_COMPLETION))
        resolveToolFinalTextStarted()
        await toolFinalCompletionRelease
        toolRegressionStage = 'complete'
        response.end(sse(stream.finish))
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
        const stream = streamingEvents(responseId, COMPLETION_TEXT, null)
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.flushHeaders()
        response.write(sse(stream.start))
        let partialOffset = 0
        for (const chunk of PARTIAL_TEXT.match(/[\s\S]{1,24}/g) ?? []) {
          response.write(sse(textDeltaEvents(stream.itemId, chunk, partialOffset)))
          response.flush?.()
          partialOffset += chunk.length
          await new Promise(resolve => setTimeout(resolve, 5))
        }
        resolvePartialWritten()
        await appendRelease
        await new Promise(resolve => setTimeout(resolve, 100))
        let appendOffset = PARTIAL_TEXT.length
        for (const chunk of APPENDED_TEXT.match(/[\s\S]{1,48}/g) ?? []) {
          response.write(sse(textDeltaEvents(stream.itemId, chunk, appendOffset)))
          response.flush?.()
          appendOffset += [...chunk].length
          await new Promise(resolve => setTimeout(resolve, 40))
        }
        resolveAppendWritten()
        await scrollButtonAppendRelease
        for (const chunk of SCROLL_BUTTON_APPENDED_TEXT.match(/[\s\S]{1,48}/g) ?? []) {
          response.write(sse(textDeltaEvents(stream.itemId, chunk, appendOffset)))
          response.flush?.()
          appendOffset += [...chunk].length
          await new Promise(resolve => setTimeout(resolve, 40))
        }
        resolveScrollButtonAppendWritten()
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

      if (requestContainsPhaseFlipPrompt(body)) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        const events = phaseFlipEvents(responseId)
        await writeSseEvents(response, events.slice(0, 4))
        await phaseFlipCompletionRelease
        await writeSseEvents(response, events.slice(4))
        response.end()
        return true
      }

      if (requestContainsLegacyConversationPrompt(body)) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(LEGACY_CONVERSATION_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      if (requestContainsVisualizationPrompt(body)) {
        const visualizationPath = join(workspacePath, 'visualizations', 'absolute-reference.html')
        const contentReference = `visualize${JSON.stringify({
          path: visualizationPath,
          mode: 'wide',
          title: VISUALIZATION_TITLE,
        })}`
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(contentReference),
            responseCompleted(responseId),
          ])
        )
        return true
      }

      if (requestContainsGeneratedImagePrompt(body)) {
        assert.equal(
          generatedImageStage,
          'initial',
          `Unexpected generated-image model stage: ${generatedImageStage}`
        )
        const tool = selectImageGenerationTool(body)
        generatedImageStage = 'awaiting-image-api'
        const toolCallEvents = tool.namespace
          ? namespacedFunctionCall(
              GENERATED_IMAGE_CALL_ID,
              tool.namespace,
              tool.name,
              tool.arguments
            )
          : functionCall(GENERATED_IMAGE_CALL_ID, tool.name, tool.arguments)
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([responseCreated(responseId), ...toolCallEvents, responseCompleted(responseId)])
        )
        return true
      }

      if (requestContainsWindowsLinkPrompt(body)) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            assistantMessage(WINDOWS_LINK_COMPLETION),
            responseCompleted(responseId),
          ])
        )
        return true
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
        await openNewChatWithE2EModel(control, uiTimeoutMs)
      }
      await selectE2EModel(
        control,
        DEFAULT_MODEL_ID,
        DEFAULT_MODEL_LABEL,
        ACTIVE_WORKBENCH_SELECTOR
      )
      if (process.env.WEWORK_E2E_MESSAGE_ORDER_ONLY === 'true') {
        await verifyStoppedTurnOrder(control)
        active = false
        return
      }
      if (process.env.WEWORK_E2E_LONG_CODE_ONLY === 'true') {
        await verifyLongCodeTerminalBurst(control)
        active = false
        return
      }
      const visualizationDirectory = join(workspacePath, 'visualizations')
      const visualizationPath = join(visualizationDirectory, 'absolute-reference.html')
      await mkdir(visualizationDirectory, { recursive: true })
      await writeFile(
        visualizationPath,
        `<section style="padding:24px;font:600 18px system-ui;color:#2563eb">${VISUALIZATION_MARKER}</section>`,
        'utf8'
      )
      await control.command('fill', COMPOSER_SELECTOR, { value: VISUALIZATION_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      const visualizationSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="codex-inline-visualization"]`
      const visualizationFrameSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="codex-inline-visualization-frame"]`
      await control.command('waitFor', visualizationFrameSelector, { timeoutMs: uiTimeoutMs })
      await waitForVisualizationBlob(control, visualizationFrameSelector, uiTimeoutMs)
      assert.equal(
        await control.command('getAttribute', visualizationSelector, {
          value: 'data-visualization-mode',
        }),
        'wide',
        'The visualize content reference did not preserve wide mode'
      )
      assert.equal(
        await control.command('getAttribute', visualizationFrameSelector, { value: 'title' }),
        VISUALIZATION_TITLE,
        'The visualize content reference did not preserve its title'
      )
      assert.equal(
        await control.command('getAttribute', visualizationFrameSelector, { value: 'sandbox' }),
        'allow-scripts',
        'The visualization iframe lost its sandbox'
      )
      const visualizationSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.ok(
        !visualizationSnapshot.text.includes('visualize'),
        'The raw visualize content reference remained visible'
      )
      await capture(control, 'streaming-text-00-absolute-visualization.png')
      if (process.env.WEWORK_E2E_VISUALIZATION_ONLY === 'true') {
        active = false
        return
      }

      await openNewChatWithE2EModel(control, uiTimeoutMs)
      await control.command('fill', COMPOSER_SELECTOR, { value: GENERATED_IMAGE_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="generated-image"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
        text: GENERATED_IMAGE_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      assert.match(
        await control.command('getAttribute', '[data-testid="generated-image"]', {
          value: 'src',
        }),
        /^blob:/,
        'The generated image was not loaded from its workspace artifact'
      )
      const generatedImageDirectory = join(workspacePath, 'outputs', 'generated-images')
      assert.ok(
        (await readdir(generatedImageDirectory)).some(name => name.endsWith('.png')),
        'The Executor did not materialize the generated image in the task workspace'
      )
      await expandCompletedProcessing(control, uiTimeoutMs)
      const generatedImageSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.ok(
        generatedImageSnapshot.text.includes('图片已生成'),
        'The generated image tool did not expose its completed status'
      )
      assert.equal(
        generatedImageSnapshot.text.includes('工具未返回内容'),
        false,
        'The generated image tool exposed an empty generic tool result'
      )
      await capture(control, 'streaming-text-00-generated-image.png')
      if (process.env.WEWORK_E2E_GENERATED_IMAGE_ONLY === 'true') {
        active = false
        return
      }

      await verifyLongCodeTerminalBurst(control)
      await verifyWindowsDriveLinkRendering(control)

      await openNewChatWithE2EModel(control, uiTimeoutMs)
      const knownLegacyTaskRows = new Set(
        JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
          testId.startsWith('runtime-local-task-row-')
        )
      )
      await control.command('fill', COMPOSER_SELECTOR, { value: LEGACY_CONVERSATION_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
        text: LEGACY_CONVERSATION_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      const legacyTaskRowTestId = await waitForNewTaskRow(
        control,
        knownLegacyTaskRows,
        LEGACY_CONVERSATION_PROMPT,
        uiTimeoutMs
      )
      for (let index = 0; index < PANE_EVICTION_BLANK_COUNT; index += 1) {
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      }
      await control.command('clickWhenEnabled', `[data-testid="${legacyTaskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
        text: LEGACY_CONVERSATION_COMPLETION,
        stableMs: 750,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', COMPOSER_SELECTOR, { value: PHASE_FLIP_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
        text: PHASE_FLIP_TEXT,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('reconcileLegacyRuntimeAssistantSnapshot', 'body', {
        value: JSON.stringify({
          address: {
            deviceId: 'local-device',
            taskId: legacyTaskRowTestId.replace('runtime-local-task-row-', ''),
          },
          content: PHASE_FLIP_TEXT,
          itemId: LEGACY_TRANSCRIPT_ITEM_ID,
        }),
      })
      const streamingPhaseFlipSnapshot = JSON.parse(
        await control.command('snapshot', SCROLLER_SELECTOR)
      )
      assert.equal(
        streamingPhaseFlipSnapshot.text.split(PHASE_FLIP_TEXT).length - 1,
        1,
        'Streaming final text was rendered more than once before the turn completed'
      )
      releasePhaseFlipCompletion()
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
        { stableMs: 750, timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
        text: PHASE_FLIP_TEXT,
        stableMs: 750,
        timeoutMs: uiTimeoutMs,
      })
      const phaseFlipSnapshot = JSON.parse(await control.command('snapshot', SCROLLER_SELECTOR))
      assert.equal(
        phaseFlipSnapshot.text.split(PHASE_FLIP_TEXT).length - 1,
        1,
        'The terminal final content was rendered more than once'
      )
      assert.equal(
        Number(await control.command('getElementCount', PROCESS_TEXT_SELECTOR)),
        0,
        'The promoted final content remained duplicated in the process section'
      )
      await capture(control, 'streaming-text-00-legacy-follow-up-promoted-once.png')
      if (process.env.WEWORK_E2E_LEGACY_STREAM_ONLY === 'true') {
        active = false
        return
      }

      await openNewChatWithE2EModel(control, uiTimeoutMs)
      await control.command('fill', COMPOSER_SELECTOR, { value: TOOL_REGRESSION_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      try {
        await Promise.race([
          toolFollowUpReceived,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('The tool-output follow-up request was not received')),
              uiTimeoutMs
            )
          ),
        ])
      } catch (error) {
        releaseToolCompletion()
        releaseToolFinalCompletion()
        throw error
      }
      await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
        text: TOOL_PREAMBLE,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(await control.command('getElementCount', ASSISTANT_CONTENT_SELECTOR)),
        0,
        'The unphased pre-tool process text was exposed as final assistant content'
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="final-processing-toggle"]`
          )
        ),
        0,
        'The tool timeline collapsed before authoritative final content arrived'
      )
      await capture(control, 'streaming-text-00-unphased-process-before-tool.png')
      await control.command('waitFor', TOOL_THINKING_INDICATOR_SELECTOR, {
        text: `正在思考 · ${REASONING_PREVIEW}`,
        timeoutMs: uiTimeoutMs,
      })
      await capture(control, 'streaming-text-01-live-reasoning-summary.png')
      releaseToolCompletion()
      await toolFinalTextStarted
      await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
        text: TOOL_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(await control.command('getElementCount', ASSISTANT_CONTENT_SELECTOR)),
        0,
        'The unphased post-tool text became final before the turn completed'
      )
      releaseToolFinalCompletion()
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
        text: TOOL_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      const liveFinalTextSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.equal(
        liveFinalTextSnapshot.text.includes(REASONING_PREVIEW),
        false,
        'The stale reasoning summary remained visible after assistant text started streaming'
      )
      await capture(control, 'streaming-text-02-reasoning-hidden-during-text.png')
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
        { stableMs: 750, timeoutMs: uiTimeoutMs }
      )
      const completedProcessingToggle = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="final-processing-toggle"]`
      await control.command('waitFor', completedProcessingToggle, { timeoutMs: uiTimeoutMs })
      assert.equal(
        await control.command('getAttribute', completedProcessingToggle, {
          value: 'aria-expanded',
        }),
        'false',
        'The completed stream left its process timeline expanded instead of collapsing it'
      )
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
      await capture(control, 'streaming-text-03-processing-collapsed.png')
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
      await capture(control, 'streaming-text-04-reasoning-removed.png')
      const shortConversationScroller = await waitForBottom(
        control,
        'The short control conversation',
        uiTimeoutMs
      )
      await assertComposerDocked(
        control,
        shortConversationScroller,
        'The composer in the short control conversation'
      )
      await capture(control, 'streaming-text-05-short-control-composer-docked.png')

      await openNewChatWithE2EModel(control, uiTimeoutMs)
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
      await capture(control, 'streaming-text-06-running-tool.png')
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
      await capture(control, 'streaming-text-07-running-tool-restored.png')
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: TIMER_COMPLETION,
        timeoutMs: 25_000,
      })
      const completedDurationBeforeSwitch = await completedToolDuration(control, uiTimeoutMs)
      await capture(control, 'streaming-text-08-tool-completed.png')
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('clickWhenEnabled', `[data-testid="${timerTaskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: TIMER_COMPLETION,
        stableMs: 750,
        timeoutMs: uiTimeoutMs,
      })
      const completedDurationAfterSwitch = await completedToolDuration(control, uiTimeoutMs)
      assert.equal(
        completedDurationAfterSwitch,
        completedDurationBeforeSwitch,
        `The completed tool duration changed from ${completedDurationBeforeSwitch}s to ${completedDurationAfterSwitch}s after switching conversations`
      )
      await capture(control, 'streaming-text-09-tool-duration-restored.png')

      await openNewChatWithE2EModel(control, uiTimeoutMs)
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
      await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
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
        await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
      }
      await retainSecondTaskWorkspace(control, uiTimeoutMs)
      await capture(control, 'streaming-text-11-ready-to-send.png')
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
      await partialWritten
      const runtimeTask = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        .workbench.currentRuntimeTask
      const runtimePartial = await waitForRuntimeAssistantText(
        control,
        {
          deviceId: runtimeTask.deviceId,
          taskId: runtimeTask.taskId,
        },
        PARTIAL_TEXT,
        uiTimeoutMs
      )
      assert.equal(
        runtimePartial,
        PARTIAL_TEXT,
        'The runtime conversation cache lost or reordered streamed text before rendering'
      )
      const immediatelyRenderedPartial = await control.command('getText', PROCESS_TEXT_SELECTOR)
      assert.equal(
        immediatelyRenderedPartial.replace(/\s+/g, ''),
        PARTIAL_TEXT.replace(/\s+/g, ''),
        `The active conversation displayed only ${immediatelyRenderedPartial.length} of ${PARTIAL_TEXT.length} streamed characters`
      )
      await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
        text: MARKER,
        stableMs: 750,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('selectText', PROCESS_TEXT_SELECTOR, { value: MARKER })
      await control.command('waitFor', '[data-testid="message-selection-actions"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="add-selection-to-conversation-button"]')
      assert.ok(
        (await control.command('getValue', COMPOSER_SELECTOR)).includes(MARKER),
        'Adding selected process text did not insert it into the running task composer'
      )
      await control.command('fill', COMPOSER_SELECTOR, { value: '' })
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
        streamingSnapshot.testIds.includes('process-text-block'),
        'The phase-less streaming response was not rendered as process content'
      )
      assert.equal(
        (await control.command('getText', PROCESS_TEXT_SELECTOR)).replace(/\s+/g, ''),
        PARTIAL_TEXT.replace(/\s+/g, ''),
        'The streaming process text duplicated or dropped response deltas'
      )
      assert.ok(
        !streamingSnapshot.text.includes(APPEND_MARKER),
        'The later assistant delta was visible before the runtime released it'
      )
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
      await control.command('focusMainWindow', 'body')
      await control.command('scrollFromBottomAsUser', SCROLLER_SELECTOR, { value: '160' })
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
        Math.abs(distanceFromTop(stableUserScrollPosition) - distanceFromTop(userScrollPosition)) <=
          8,
        `The streaming conversation jumped from ${distanceFromTop(userScrollPosition)}px to ${distanceFromTop(stableUserScrollPosition)}px from the content top after the user scrolled upward`
      )
      await assertComposerDocked(
        control,
        stableUserScrollPosition,
        'The composer after the user scrolled the streaming conversation'
      )

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
      await capture(control, 'streaming-text-12-user-scrolled-up.png')

      const previousContentLength = (await control.command('getText', PROCESS_TEXT_SELECTOR)).length
      assert.ok(
        previousContentLength > 0,
        'The streaming response disappeared before the later content arrived'
      )
      await control.command('startScrollStabilitySampling', VIEWPORT_ANCHOR_SCOPE_SELECTOR, {
        value: JSON.stringify({
          anchorText: VIEWPORT_ANCHOR_TEXT,
          durationMs: 2_000,
          scrollerSelector: SCROLLER_SELECTOR,
        }),
        timeoutMs: 6_000,
      })
      releaseAppend()
      await appendWritten
      let stabilitySamples
      const stabilityDeadline = Date.now() + 6_000
      while (Date.now() < stabilityDeadline) {
        stabilitySamples = JSON.parse(
          await control.command('getScrollStabilitySample', VIEWPORT_ANCHOR_SCOPE_SELECTOR)
        )
        if (stabilitySamples.done) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert.ok(
        stabilitySamples?.done,
        `The streaming scroll stability sampler did not finish: ${JSON.stringify({
          frames: stabilitySamples?.frames.length ?? 0,
          missingFrames: stabilitySamples?.missingFrames ?? 0,
          scrollEvents: stabilitySamples?.scrollEvents.length ?? 0,
        })}`
      )
      assert.ok(
        stabilitySamples.frames.length >= 12,
        `The WebView captured only ${stabilitySamples.frames.length} streaming stability samples`
      )
      assert.equal(
        stabilitySamples.missingFrames,
        0,
        'The user-selected text disappeared while the streaming response rerendered'
      )
      const anchorTops = stabilitySamples.frames.map(sample => sample.anchorTop)
      const anchorRange = Math.max(...anchorTops) - Math.min(...anchorTops)
      const effectiveScrollEvents = stabilitySamples.scrollEvents.filter(
        sample => Math.abs(distanceFromTop(sample) - distanceFromTop(scrollerBeforeAppend)) >= 0.5
      )
      const scrollDirections = effectiveScrollEvents
        .slice(1)
        .map((sample, index) =>
          Math.abs(distanceFromTop(sample) - distanceFromTop(effectiveScrollEvents[index])) < 0.5
            ? 0
            : Math.sign(distanceFromTop(sample) - distanceFromTop(effectiveScrollEvents[index]))
        )
        .filter(direction => direction !== 0)
      const directionReversals = scrollDirections.filter(
        (direction, index) => index > 0 && direction !== scrollDirections[index - 1]
      ).length
      assert.ok(
        anchorRange <= 8 && directionReversals === 0 && effectiveScrollEvents.length === 0,
        `The user-selected text jittered while chunks streamed: ${JSON.stringify({
          anchorRange,
          directionReversals,
          effectiveScrollEvents,
          stabilitySamples,
        })}`
      )
      const scrollerAfterAppend = await waitForRenderedAppend(
        control,
        previousContentLength,
        uiTimeoutMs
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
        Math.abs(distanceFromTop(scrollerAfterAppend) - distanceFromTop(scrollerBeforeAppend)) <= 8,
        `The paused streaming scroller moved from ${distanceFromTop(scrollerBeforeAppend)}px to ${distanceFromTop(scrollerAfterAppend)}px from the content top`
      )
      await assertComposerDocked(
        control,
        scrollerAfterAppend,
        'The composer after streamed content changed the virtualized conversation height'
      )
      await capture(control, 'streaming-text-13-anchor-stable-after-append.png')

      await control.command('waitFor', SCROLL_TO_BOTTOM_BUTTON_SELECTOR, {
        timeoutMs: uiTimeoutMs,
      })
      releaseScrollButtonAppend()
      await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
        text: SCROLL_BUTTON_APPEND_MARKER,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('pointerDown', SCROLL_TO_BOTTOM_BUTTON_SELECTOR)
      await control.command('click', SCROLL_TO_BOTTOM_BUTTON_SELECTOR)
      await scrollButtonAppendWritten
      await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
        text: SCROLL_BUTTON_APPEND_MARKER,
        stableMs: 750,
        timeoutMs: uiTimeoutMs,
      })
      const pinnedBeforeSwitch = await waitForBottom(
        control,
        'The growing streaming conversation after clicking the scroll-to-bottom button',
        5_000
      )
      await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
        text: APPEND_MARKER,
        stableMs: 750,
        timeoutMs: uiTimeoutMs,
      })
      assert.ok(
        distanceFromBottom(pinnedBeforeSwitch) <= 8,
        `The scroll-to-bottom button left the growing streaming conversation ${distanceFromBottom(pinnedBeforeSwitch)}px from the bottom`
      )
      await capture(control, 'streaming-text-14-scroll-button-followed-layout-growth.png')
      await new Promise(resolve => setTimeout(resolve, 250))
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
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
      await assertComposerDocked(
        control,
        pinnedAfterSwitch,
        'The composer after reopening the long virtualized conversation'
      )
      await capture(control, 'streaming-text-14-bottom-restored-after-task-switch.png')

      for (let index = 0; index < PANE_EVICTION_BLANK_COUNT; index += 1) {
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      }
      await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
        text: MARKER,
        stableMs: 750,
        timeoutMs: uiTimeoutMs,
      })
      const remountedScroller = await waitForBottom(
        control,
        'The remounted long virtualized conversation',
        uiTimeoutMs
      )
      await assertComposerDocked(
        control,
        remountedScroller,
        'The composer after remounting the long virtualized conversation'
      )
      await capture(control, 'streaming-text-15-composer-docked-after-pane-remount.png')
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
      await capture(control, 'streaming-text-16-thinking-below-partial-response.png')

      releaseResponse()
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
        text: MARKER,
        timeoutMs: uiTimeoutMs,
      })

      await control.command('scrollFromBottomAsUser', SCROLLER_SELECTOR, { value: '160' })
      const completedUserScrollPosition = await getSingleElementMetrics(
        control,
        SCROLLER_SELECTOR,
        'The completed conversation immediately after the user scrolled upward'
      )
      assert.ok(
        distanceFromBottom(completedUserScrollPosition) > 8,
        'The user scroll did not move the completed conversation away from the bottom'
      )
      await assertScrollPositionRemainsStable(
        control,
        completedUserScrollPosition,
        'The completed conversation while delayed bottom-follow work could still run',
        uiTimeoutMs
      )
      await capture(control, 'streaming-text-18-completed-user-scroll-stable.png')
      await control.command('scrollToBottomAsUser', SCROLLER_SELECTOR)
      await waitForBottom(
        control,
        'The completed conversation after restoring the downstream test precondition',
        uiTimeoutMs
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
      await capture(control, 'streaming-text-17-response-completed.png')

      await verifyStoppedTurnOrder(control)
      active = false
    },

    diagnostics() {
      return { receivedTargetRequest: Boolean(targetRequest) }
    },
  }
}
