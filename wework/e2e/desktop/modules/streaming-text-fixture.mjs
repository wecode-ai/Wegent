import { selectE2EModel, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL } from './shared.mjs'
import assert from 'node:assert/strict'

export const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
export const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
export const TOOL_REGRESSION_PROMPT = 'WEWORK_DESKTOP_E2E_TOOL_TEXT_OFFSET'
export const TOOL_PREAMBLE = '找到了关键错误。看一下失败前后的上下文：'
export const TOOL_COMPLETION = '本地分支落后于 main，CI 跑的提交是 719f99694。'
export const TOOL_DETAIL_PERSISTENCE_PROMPT = 'WEWORK_DESKTOP_E2E_TOOL_DETAIL_PERSISTS'
export const TOOL_DETAIL_PERSISTENCE_CALL_ID = 'wework-tool-detail-persistence'
export const TOOL_DETAIL_PERSISTENCE_OUTPUT = 'WEWORK_DESKTOP_E2E_TOOL_DETAIL_OUTPUT'
export const TOOL_DETAIL_PERSISTENCE_COMPLETION =
  'WEWORK_DESKTOP_E2E_TOOL_DETAIL_PERSISTS_FINAL_ANSWER'
export const LEGACY_CONVERSATION_PROMPT = 'WEWORK_DESKTOP_E2E_LEGACY_CONVERSATION_INITIAL'
export const LEGACY_CONVERSATION_COMPLETION = 'WEWORK_DESKTOP_E2E_LEGACY_CONVERSATION_COMPLETE'
export const LEGACY_TRANSCRIPT_ITEM_ID = 'wework-desktop-e2e-legacy-assistant-text'
export const LONG_CODE_PROMPT = 'WEWORK_DESKTOP_E2E_LONG_CODE_TERMINAL_BURST'
export const LONG_CODE_STREAM_MARKER = 'WEWORK_DESKTOP_E2E_LONG_CODE_LINE_055'
export const LONG_CODE_MARKER = 'WEWORK_DESKTOP_E2E_LONG_CODE_LINE_110'
export const LONG_CODE_COMPLETION = [
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
export const LONG_CODE_REASONING = Array.from(
  { length: 180 },
  (_, index) => `Completed reasoning line ${index + 1} for the terminal rendering burst.`
).join('\n')
export const VISUALIZATION_PROMPT = 'WEWORK_DESKTOP_E2E_ABSOLUTE_VISUALIZATION'
export const VISUALIZATION_TITLE = 'Absolute visualization E2E'
export const VISUALIZATION_MARKER = 'WEWORK_DESKTOP_E2E_VISUALIZATION_VISIBLE'
export const GENERATED_IMAGE_PROMPT = 'WEWORK_DESKTOP_E2E_GENERATED_IMAGE'
export const GENERATED_IMAGE_COMPLETION = 'WEWORK_DESKTOP_E2E_GENERATED_IMAGE_COMPLETE'
export const GENERATED_IMAGE_CALL_ID = 'wework-generated-image'
export const GENERATED_IMAGE_REVISED_PROMPT =
  'A small generated image used by the desktop regression test'
export const WINDOWS_LINK_PROMPT = 'WEWORK_DESKTOP_E2E_WINDOWS_DRIVE_LINK'
export const WINDOWS_LINK_LABEL = 'wegent'
export const WINDOWS_LINK_COMPLETION = '[wegent](C:/projects/example-app/wegent)'
export const PHASE_FLIP_PROMPT = 'WEWORK_DESKTOP_E2E_PROCESS_TO_FALLBACK_FINAL'
export const PHASE_FLIP_TEXT = 'WEWORK_DESKTOP_E2E_FALLBACK_FINAL_FROM_PROCESS'
export const RECLASSIFIED_COMMENTARY_PROMPT = 'WEWORK_DESKTOP_E2E_RECLASSIFIED_COMMENTARY'
export const RECLASSIFIED_COMMENTARY_TEXT = 'WEWORK_DESKTOP_E2E_RECLASSIFIED_PROCESS_TEXT'
export const RECLASSIFIED_COMMENTARY_FINAL = 'WEWORK_DESKTOP_E2E_RECLASSIFIED_REAL_FINAL'
export const RECLASSIFIED_COMMENTARY_CALL_ID = 'wework-reclassified-commentary-tool'
export const TIMER_PROMPT = 'WEWORK_DESKTOP_E2E_RUNNING_TIMER_PERSISTS'
export const TIMER_COMPLETION = 'WEWORK_DESKTOP_E2E_RUNNING_TIMER_COMPLETE'
export const SUBAGENT_PROMPT = 'WEWORK_DESKTOP_E2E_SUBAGENT_STREAMING_PANEL'
export const SUBAGENT_CALL_ID = 'wework-subagent-streaming-panel'
export const SUBAGENT_WAIT_CALL_ID = 'wework-subagent-wait'
export const SUBAGENT_CHILD_TOOL_CALL_ID = 'wework-subagent-child-tool'
export const SUBAGENT_CHILD_PROMPT = 'Inspect the child event stream and report the routing result.'
export const SUBAGENT_CHILD_TOOL_MARKER = 'WEWORK_DESKTOP_E2E_SUBAGENT_TOOL'
export const SUBAGENT_CHILD_REASONING = 'WEWORK_DESKTOP_E2E_SUBAGENT_REASONING'
export const SUBAGENT_CHILD_COMMENTARY = 'WEWORK_DESKTOP_E2E_SUBAGENT_COMMENTARY'
export const SUBAGENT_CHILD_TOOL_TIMEOUT_MS = 10_000
export const SUBAGENT_CHILD_STARTUP_TIMEOUT_MS = 60_000
export const SUBAGENT_CHILD_TOOL_START = `${SUBAGENT_CHILD_TOOL_MARKER}_START`
export const SUBAGENT_CHILD_TOOL_COMPLETE = `${SUBAGENT_CHILD_TOOL_MARKER}_COMPLETE`
export const SUBAGENT_CHILD_PARTIAL = 'WEWORK_DESKTOP_E2E_SUBAGENT_PARTIAL'
export const SUBAGENT_CHILD_FINAL = 'WEWORK_DESKTOP_E2E_SUBAGENT_COMPLETE'
export const SUBAGENT_CHILD_COMPLETION = `${SUBAGENT_CHILD_PARTIAL}\n\n${SUBAGENT_CHILD_FINAL}`
export const SUBAGENT_PARENT_COMPLETION = 'WEWORK_DESKTOP_E2E_SUBAGENT_PARENT_COMPLETE'
export const ORDER_STOP_PROMPT = 'WEWORK_DESKTOP_E2E_ORDER_STOPPED_TURN'
export const ORDER_STOP_PARTIAL = 'WEWORK_DESKTOP_E2E_ORDER_STOP_PARTIAL'
export const ORDER_FOLLOW_UP_PREFIX = 'WEWORK_DESKTOP_E2E_ORDER_FOLLOW_UP'
export const ORDER_COMPLETION_PREFIX = 'WEWORK_DESKTOP_E2E_ORDER_COMPLETION'
export const ORDER_FOLLOW_UP_COUNT = 26
export const HIDDEN_REASONING = 'WEWORK_DESKTOP_E2E_HIDDEN_REASONING_CONTENT'
export const REASONING_SUMMARY = 'WEWORK_DESKTOP_E2E_REASONING_SUMMARY'
export const REASONING_PREVIEW = REASONING_SUMMARY.replaceAll('_', ' ')
export const INITIAL_PROMPT = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_INITIAL'
export const HISTORY_PROMPT_PREFIX = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_HISTORY'
export const PROMPT =
  'WEWORK_DESKTOP_E2E_STREAMING_TEXT: keep the partial response active until released.'
export const MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_PARTIAL'
export const VIEWPORT_MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_VIEWPORT_ANCHOR'
export const APPEND_MARKER = 'WEWORK_DESKTOP_E2E_STREAMING_TEXT_APPENDED'
export const SCROLL_BUTTON_APPEND_MARKER = 'WEWORK_DESKTOP_E2E_SCROLL_BUTTON_APPEND'
export const COMPLETED_SCROLL_ANCHOR_TEXT =
  'Scroll button growth paragraph 21: the click must continue following the virtualized conversation bottom.'
export const COMPLETED_SCROLL_ANCHOR_E2E_ID = 'streaming-text-completed-scroll-anchor'
export const ATTACHMENT_FILENAME = 'streaming-turn-navigation.png'
export const ATTACHMENT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC'
export const TURN_NAVIGATION_MARKER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-marker"]`
export const SCROLLER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`
export const SCROLL_TO_BOTTOM_BUTTON_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="scroll-to-bottom-button"]`
export const COMPOSER_CARD_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-floating-composer-card"]`
export const ASSISTANT_CONTENT_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`
export const ASSISTANT_MESSAGE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
export const ASSISTANT_MARKDOWN_LINK_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-markdown-link"]`
export const THINKING_INDICATOR_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="thinking-indicator"]`
export const TOOL_THINKING_INDICATOR_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="tool-thinking-indicator"]`
export const USER_MESSAGE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
export const USER_MESSAGE_E2E_ID = 'streaming-text-latest-user-message'
export const USER_MESSAGE_SELECTOR_MARKED = `${ACTIVE_WORKBENCH_SELECTOR} [data-e2e-anchor-id="${USER_MESSAGE_E2E_ID}"]`
export const PROCESSING_SUMMARY_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="processing-summary-header"]`
export const PROCESS_TEXT_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-text-block"]`
export const LONG_CODE_SCROLL_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="markdown-code-scroll-container"]`
export const LONG_CODE_E2E_ID = 'streaming-text-long-code'
export const LONG_CODE_MARKED_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-e2e-anchor-id="${LONG_CODE_E2E_ID}"]`
export const VIEWPORT_ANCHOR_TEXT = `${VIEWPORT_MARKER}: this paragraph must remain fixed after the user scrolls upward.`
export const VIEWPORT_ANCHOR_E2E_ID = 'streaming-text-viewport-anchor'
export const VIEWPORT_ANCHOR_SCOPE_SELECTOR = `${PROCESS_TEXT_SELECTOR} [data-scroll-anchor]`
export const VIEWPORT_ANCHOR_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-e2e-anchor-id="${VIEWPORT_ANCHOR_E2E_ID}"]`
export const COMPLETED_SCROLL_ANCHOR_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-e2e-anchor-id="${COMPLETED_SCROLL_ANCHOR_E2E_ID}"]`
export const HISTORY_PARAGRAPHS = Array.from(
  { length: 28 },
  (_, index) =>
    `Completed history paragraph ${index + 1}: this content belongs to the previous assistant turn.`
)
export const INITIAL_COMPLETION = `WEWORK_DESKTOP_E2E_STREAMING_TEXT_INITIAL_COMPLETE\n\n${HISTORY_PARAGRAPHS.join('\n\n')}`
export const HISTORY_TURNS = Array.from({ length: 4 }, (_, index) => ({
  prompt: `${HISTORY_PROMPT_PREFIX}_${index + 1}`,
  completion: `WEWORK_DESKTOP_E2E_STREAMING_TEXT_HISTORY_COMPLETE_${index + 1}\n\n${Array.from(
    { length: 4 },
    (_, paragraphIndex) =>
      `Follow-up history paragraph ${index + 1}.${paragraphIndex + 1}: this turn keeps the conversation on the virtualized path.`
  ).join('\n\n')}`,
}))
export const STREAMING_TURN_INDEX = HISTORY_TURNS.length + 1
export const PANE_EVICTION_BLANK_COUNT = 4
export const INITIAL_PARAGRAPHS = Array.from({ length: 28 }, (_, index) =>
  index === 26
    ? VIEWPORT_ANCHOR_TEXT
    : `Initial streaming paragraph ${index + 1}: enough text keeps the response taller than the desktop chat viewport.`
)
export const APPENDED_PARAGRAPHS = Array.from({ length: 14 }, (_, index) =>
  index === 0
    ? `${APPEND_MARKER}: later streamed content is now visible in the response.`
    : `Later streaming paragraph ${index + 1}: this content arrives after the user pauses automatic following.`
)
export const PARTIAL_TEXT = `${MARKER}: response remains active while final checks continue. 中文流式内容不得重复。\n\n${INITIAL_PARAGRAPHS.join('\n\n')}`
export const APPENDED_TEXT = `\n\n${APPENDED_PARAGRAPHS.join('\n\n')}`
export const SCROLL_BUTTON_APPENDED_TEXT = `\n\n${Array.from({ length: 24 }, (_, index) =>
  index === 0
    ? `${SCROLL_BUTTON_APPEND_MARKER}: content keeps growing after the user clicks the jump-to-bottom button.`
    : `Scroll button growth paragraph ${index + 1}: the click must continue following the virtualized conversation bottom.`
).join('\n\n')}`

export async function openNewChatWithE2EModel(control, timeoutMs) {
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL, ACTIVE_WORKBENCH_SELECTOR)
}
export const COMPLETION_TEXT = `${PARTIAL_TEXT}${APPENDED_TEXT}${SCROLL_BUTTON_APPENDED_TEXT}\n\nCOMPLETE`

export function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

export function responseCreated(id) {
  return { type: 'response.created', response: { id } }
}

export function responseCompleted(id, output) {
  return {
    type: 'response.completed',
    response: {
      id,
      ...(output ? { output } : {}),
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

export function assistantMessage(text, phase) {
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

export function functionCall(callId, name, argumentsValue) {
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

export function namespacedFunctionCall(callId, namespace, name, argumentsValue) {
  return functionCall(callId, name, argumentsValue).map(event => ({
    ...event,
    item: { ...event.item, namespace },
  }))
}

export function reasoningEvents(itemId, text, deltaChunkSize = text.length) {
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

export function streamingEvents(
  id,
  completionText = COMPLETION_TEXT,
  phase = 'final_answer',
  outputIndex = 0
) {
  const itemId = `${id}-message`
  const phaseFields = phase ? { phase } : {}
  return {
    itemId,
    outputIndex,
    start: [
      responseCreated(id),
      {
        type: 'response.output_item.added',
        output_index: outputIndex,
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
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
    ],
    finish: [
      {
        type: 'response.output_text.done',
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text: completionText,
      },
      {
        type: 'response.output_item.done',
        output_index: outputIndex,
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

export function longCodeStreamingEvents(id) {
  const reasoning = reasoningEvents('wework-long-code-reasoning', LONG_CODE_REASONING, 4)
  const stream = streamingEvents(id, LONG_CODE_COMPLETION, 'final_answer', 1)
  const output = [reasoning.at(-1).item, stream.finish.at(-2).item]
  return {
    ...stream,
    start: [...stream.start.slice(0, 1), ...reasoning, ...stream.start.slice(1)],
    finish: [...stream.finish.slice(0, -1), responseCompleted(id, output)],
  }
}

export function phaseFlipEvents(id) {
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

export function reclassifiedCommentaryToolEvents(id, tool) {
  const itemId = `${id}-reclassified-commentary`
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
    ...textDeltaEvents(itemId, RECLASSIFIED_COMMENTARY_TEXT),
    {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: RECLASSIFIED_COMMENTARY_TEXT,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: RECLASSIFIED_COMMENTARY_TEXT,
            annotations: [],
          },
        ],
        phase: 'commentary',
      },
    },
    ...functionCall(RECLASSIFIED_COMMENTARY_CALL_ID, tool.name, tool.arguments),
    responseCompleted(id),
  ]
}

export function textDeltaEvents(itemId, text, initialOffset = 0, outputIndex = 0) {
  return [
    {
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      delta: text,
      offset: initialOffset,
    },
  ]
}

export async function writeSseEvents(response, events) {
  for (const event of events) {
    response.write(sse([event]))
    response.flush?.()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

export async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function requestContainsPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(PROMPT)
}

export function requestContainsInitialPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(INITIAL_PROMPT)
}

export function findHistoryTurn(body) {
  const input = JSON.stringify(body.input ?? [])
  return HISTORY_TURNS.findLast(turn => input.includes(turn.prompt))
}

export function requestContainsToolRegressionPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(TOOL_REGRESSION_PROMPT)
}

export function requestContainsToolDetailPersistencePrompt(body) {
  return JSON.stringify(body.input ?? []).includes(TOOL_DETAIL_PERSISTENCE_PROMPT)
}

export function requestContainsPhaseFlipPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(PHASE_FLIP_PROMPT)
}

export function requestContainsReclassifiedCommentaryPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(RECLASSIFIED_COMMENTARY_PROMPT)
}

export function requestContainsLegacyConversationPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(LEGACY_CONVERSATION_PROMPT)
}

export function requestContainsVisualizationPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(VISUALIZATION_PROMPT)
}

export function requestContainsGeneratedImagePrompt(body) {
  return JSON.stringify(body.input ?? []).includes(GENERATED_IMAGE_PROMPT)
}

export function requestContainsWindowsLinkPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(WINDOWS_LINK_PROMPT)
}

export function requestContainsTimerPrompt(body) {
  return JSON.stringify(body.input ?? []).includes(TIMER_PROMPT)
}

export function requestContainsSubagentPrompt(body) {
  return latestModelInputText(body).includes(SUBAGENT_PROMPT)
}

export function latestModelInputText(body) {
  const input = Array.isArray(body.input) ? body.input.at(-1) : body.input
  const message = Array.isArray(body.messages) ? body.messages.at(-1) : null
  return JSON.stringify(input ?? message ?? '')
}

export function orderFollowUpNumber(body) {
  const match = latestModelInputText(body).match(new RegExp(`${ORDER_FOLLOW_UP_PREFIX}_(\\d+)`))
  return match ? Number(match[1]) : null
}

export function requestContainsToolOutput(body) {
  return JSON.stringify(body.input ?? []).includes('function_call_output')
}

export function requestContainsToolOutputForCall(body, callId) {
  return (Array.isArray(body.input) ? body.input : []).some(
    item => item?.type === 'function_call_output' && item.call_id === callId
  )
}

export async function waitForRuntimePaneReadyToSend(control, timeoutMs) {
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

export async function waitForRuntimeAssistantText(control, address, expectedText, timeoutMs) {
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

export function selectShellTool(body, workspacePath, command = 'pwd', timeoutMs = 1_000) {
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

export function selectImageGenerationTool(body) {
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

export async function getSingleElementMetrics(control, selector, description) {
  const metrics = JSON.parse(await control.command('getElementMetrics', selector))
  assert.equal(metrics.length, 1, `${description} matched ${metrics.length} elements`)
  return metrics[0]
}

export function distanceFromBottom(metrics) {
  if (metrics.scrollOrigin === 'bottom') {
    return Math.max(0, -metrics.scrollTop)
  }
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop)
}

export function distanceFromTop(metrics) {
  if (metrics.scrollOrigin === 'bottom') {
    return Math.max(0, metrics.scrollHeight - metrics.clientHeight + metrics.scrollTop)
  }
  return Math.max(0, metrics.scrollTop)
}

export function assertElementFullyVisible(elementMetrics, scrollerMetrics, description) {
  assert.ok(
    elementMetrics.top >= scrollerMetrics.top && elementMetrics.bottom <= scrollerMetrics.bottom,
    `${description} was not fully visible (element=${elementMetrics.top}-${elementMetrics.bottom}, scroller=${scrollerMetrics.top}-${scrollerMetrics.bottom})`
  )
}

export function toolDurationSeconds(text) {
  return Number(text.match(/(\d+(?:\.\d+)?)s/)?.[1] ?? 0)
}

export async function assertComposerDocked(control, scrollerMetrics, description) {
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

export async function waitForToolDuration(control, minimumSeconds, timeoutMs) {
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

export function processingDurationSeconds(text) {
  const minutes = Number(text.match(/(\d+)\s*分钟/)?.[1] ?? 0)
  const seconds = Number(text.match(/(\d+)\s*秒/)?.[1] ?? 0)
  return minutes * 60 + seconds
}

export async function expandCompletedProcessing(control, timeoutMs) {
  const finalToggle = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="final-processing-toggle"]`
  await control.command('setExpanded', finalToggle, { value: 'true', timeoutMs })
  await control.command('waitFor', `${finalToggle}[aria-expanded="true"]`, { timeoutMs })
  const summaryToggle = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="processing-summary-toggle"]`
  await control.command('setExpanded', summaryToggle, { value: 'true', timeoutMs })
  await control.command('waitFor', `${summaryToggle}[aria-expanded="true"]`, { timeoutMs })
}

export async function completedToolDuration(control, timeoutMs) {
  const selector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="tool-block-duration"]`
  await expandCompletedProcessing(control, timeoutMs)
  await control.command('waitFor', selector, { timeoutMs })
  const text = await control.command('getText', selector)
  const duration = toolDurationSeconds(text)
  assert.ok(duration > 0, `The completed tool duration was missing: ${text}`)
  return duration
}

export async function waitForBottom(control, description, timeoutMs) {
  const startedAt = Date.now()
  let metrics
  while (Date.now() - startedAt < timeoutMs) {
    metrics = await getSingleElementMetrics(control, SCROLLER_SELECTOR, description)
    if (distanceFromBottom(metrics) <= 8) return metrics
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${description} remained ${distanceFromBottom(metrics)}px from the bottom`)
}

export async function assertScrollPositionRemainsStable(
  control,
  initialMetrics,
  anchorSelector,
  initialAnchorMetrics,
  description,
  timeoutMs
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const metrics = await getSingleElementMetrics(control, SCROLLER_SELECTOR, description)
    const anchorMetrics = await getSingleElementMetrics(
      control,
      anchorSelector,
      `${description} anchor`
    )
    assert.ok(
      distanceFromBottom(metrics) > 8,
      `${description} returned to the bottom after the user scrolled upward`
    )
    assert.ok(
      Math.abs(anchorMetrics.top - initialAnchorMetrics.top) <= 8,
      `${description} moved the visible anchor from ${initialAnchorMetrics.top}px to ${anchorMetrics.top}px on screen`
    )
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

export async function waitForRenderedAppend(control, previousContentLength, timeoutMs) {
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

export async function waitForFolderPath(control, expectedPath, timeoutMs) {
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

export async function waitForProjectWorkButton(control, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (Number(await control.command('getElementCount', '[data-testid="project-work-button"]'))) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The streaming-text project selector did not become available')
}

export async function waitForProjectBranch(control, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const branch = await control.command('getText', '[data-testid="project-branch-button"]')
    if (branch && !/Loading|加载中/.test(branch)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The streaming-text project branch did not finish loading')
}

export async function waitForVisualizationBlob(control, selector, timeoutMs) {
  const startedAt = Date.now()
  let source = ''
  while (Date.now() - startedAt < timeoutMs) {
    source = await control.command('getAttribute', selector, { value: 'src' })
    if (source.startsWith('blob:')) return source
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`The absolute visualization did not load through the asset protocol: ${source}`)
}

export async function createLocalProject(control, workspacePath, timeoutMs) {
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

export async function waitForNewTaskRow(control, knownTaskRows, expectedText, timeoutMs) {
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

export async function retainSecondTaskWorkspace(control, timeoutMs) {
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

export async function sendOrderFollowUp(control, index, uiTimeoutMs, modelResponseTimeoutMs) {
  const prompt = `${ORDER_FOLLOW_UP_PREFIX}_${index}`
  assert.equal(
    await control.command('fill', COMPOSER_SELECTOR, { value: prompt }),
    prompt,
    `Follow-up ${index} was not filled into the active composer`
  )
  await control.command(
    'clickWhenEnabled',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
    { timeoutMs: uiTimeoutMs, visible: true }
  )
  const response = await control.awaitScenarioRequestCount(
    'message_order_follow_up',
    index,
    modelResponseTimeoutMs
  )
  assert.equal(response.followUpNumber, index, 'The model answered a different follow-up turn')
  await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
    text: `${ORDER_COMPLETION_PREFIX}_${index}`,
    timeoutMs: uiTimeoutMs,
  })
}
