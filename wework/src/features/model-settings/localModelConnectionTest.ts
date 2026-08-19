import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { shouldUseTauriFetch } from '@/api/http'
import {
  buildLocalModelRequestUrl,
  defaultLocalModelToolProfile,
  normalizeLocalModelApiFormat,
  normalizeLocalModelId,
  type LocalModelApiFormat,
  type LocalModelToolProfile,
} from './localModelSettings'

const DEFAULT_TEST_TIMEOUT_MS = 15_000
const DUMMY_API_KEY = 'dummy'

export interface TestLocalModelConnectionInput {
  baseUrl: string
  apiFormat?: LocalModelApiFormat | null
  requestPath?: string | null
  modelId: string
  toolProfile?: LocalModelToolProfile | null
  apiKey?: string | null
}

export interface TestLocalModelConnectionOptions {
  fetcher?: typeof fetch
  timeoutMs?: number
}

export interface TestLocalModelConnectionResult {
  status: number
  toolCalling: true
}

const PROBE_TOOL_NAME = 'wework_capability_probe'
const APPLY_PATCH_TOOL_NAME = 'apply_patch'
const APPLY_PATCH_PROBE =
  '*** Begin Patch\n*** Add File: wework-capability-probe.txt\n+PING\n*** End Patch\n'
const APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`

function testRequestBody(
  apiFormat: LocalModelApiFormat,
  model: string,
  toolProfile: LocalModelToolProfile
): Record<string, unknown> {
  if (apiFormat === 'anthropic-messages') {
    return {
      model,
      messages: [{ role: 'user', content: 'Call the capability probe with value PING.' }],
      max_tokens: 64,
      stream: false,
      tools: [
        {
          name: PROBE_TOOL_NAME,
          description: 'Return the exact probe value.',
          input_schema: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
          },
        },
      ],
    }
  }
  if (apiFormat === 'openai-chat-completions') {
    return {
      model,
      messages: [{ role: 'user', content: 'Call the capability probe with value PING.' }],
      max_tokens: 64,
      stream: false,
      tools: [
        {
          type: 'function',
          function: {
            name: PROBE_TOOL_NAME,
            description: 'Return the exact probe value.',
            parameters: {
              type: 'object',
              properties: { input: { type: 'string' } },
              required: ['input'],
            },
          },
        },
      ],
    }
  }
  const custom = toolProfile === 'custom'
  const prompt = custom
    ? `Call apply_patch with this exact patch:\n${APPLY_PATCH_PROBE}`
    : 'Call the capability probe with value PING.'
  return {
    model,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      },
    ],
    stream: apiFormat === 'openai-responses',
    store: false,
    tools: custom
      ? [
          {
            type: 'custom',
            name: APPLY_PATCH_TOOL_NAME,
            description:
              'Use the apply_patch tool to edit files. This is a freeform tool, so do not wrap the patch in JSON.',
            format: { type: 'grammar', syntax: 'lark', definition: APPLY_PATCH_GRAMMAR },
          },
        ]
      : [
          {
            type: 'function',
            name: PROBE_TOOL_NAME,
            description: 'Return the exact probe value.',
            parameters: {
              type: 'object',
              properties: { input: { type: 'string' } },
              required: ['input'],
            },
          },
        ],
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function normalizeStreamedToolItem(item: unknown): Record<string, unknown> | null {
  const candidate = recordOf(item)
  if (!candidate) return null
  if (candidate.type !== 'custom_tool_call' && candidate.type !== 'function_call') return null
  const input = candidate.input ?? candidate.arguments
  return {
    type: candidate.type,
    name: candidate.name,
    ...(typeof input === 'string' ? { input } : {}),
  }
}

function responseItemsFromEvent(
  payload: Record<string, unknown>,
  items: Map<string, Record<string, unknown>>
): void {
  const type = typeof payload.type === 'string' ? payload.type : ''
  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = normalizeStreamedToolItem(payload.item)
    if (item) {
      const key =
        typeof payload.item === 'object' && payload.item !== null && 'id' in payload.item
          ? String((payload.item as Record<string, unknown>).id)
          : String(payload.output_index ?? items.size)
      items.set(key, item)
    }
    return
  }
  if (type === 'response.completed') {
    const response = recordOf(payload.response)
    for (const item of arrayOf(response?.output)) {
      const normalized = normalizeStreamedToolItem(item)
      if (!normalized) continue
      const key =
        typeof item === 'object' && item !== null && 'id' in item
          ? String((item as Record<string, unknown>).id)
          : String(items.size)
      items.set(key, normalized)
    }
    return
  }
  if (
    type === 'response.custom_tool_call_input.done' ||
    type === 'response.function_call_arguments.done'
  ) {
    const itemId =
      typeof payload.item_id === 'string' ? payload.item_id : String(payload.output_index ?? '')
    const input = payload.input ?? payload.arguments
    if (typeof input !== 'string' || !itemId) return
    const existing = items.get(itemId)
    if (existing) items.set(itemId, { ...existing, input })
    return
  }
}

function parseResponsesStream(text: string): { output: Record<string, unknown>[] } {
  const items = new Map<string, Record<string, unknown>>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    const record = recordOf(payload)
    if (record) responseItemsFromEvent(record, items)
  }
  return { output: [...items.values()] }
}

async function readResponsesProbeBody(response: Response): Promise<unknown> {
  const text = await response.text()
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) return parseResponsesStream(text)
  if (text.includes('data:')) {
    const streamed = parseResponsesStream(text)
    if (streamed.output.length > 0) return streamed
  }
  try {
    return JSON.parse(text)
  } catch (parseError) {
    throw new Error('Model returned a non-JSON response body', { cause: parseError })
  }
}

function hasProbeToolCall(
  apiFormat: LocalModelApiFormat,
  toolProfile: LocalModelToolProfile,
  body: unknown
): boolean {
  const value = recordOf(body)
  if (!value) return false
  if (apiFormat === 'anthropic-messages') {
    return arrayOf(value.content).some(item => {
      const candidate = recordOf(item)
      return candidate?.type === 'tool_use' && candidate.name === PROBE_TOOL_NAME
    })
  }
  if (apiFormat === 'openai-chat-completions') {
    return arrayOf(value.choices).some(choice => {
      const message = recordOf(recordOf(choice)?.message)
      return arrayOf(message?.tool_calls).some(call => {
        const fn = recordOf(recordOf(call)?.function)
        return fn?.name === PROBE_TOOL_NAME
      })
    })
  }
  const expectedToolName = toolProfile === 'custom' ? APPLY_PATCH_TOOL_NAME : PROBE_TOOL_NAME
  return arrayOf(value.output).some(item => {
    const candidate = recordOf(item)
    return (
      (candidate?.type === 'custom_tool_call' || candidate?.type === 'function_call') &&
      candidate.name === expectedToolName &&
      (toolProfile !== 'custom' || candidate.input === APPLY_PATCH_PROBE)
    )
  })
}

function summarizeProbeFailure(body: unknown): string {
  const value = recordOf(body)
  const output = value ? arrayOf(value.output) : []
  if (output.length === 0) {
    const responseKeys = value ? Object.keys(value).join(', ') : ''
    const status = typeof value?.status === 'string' ? value.status : ''
    const hasOutputKey = value ? Object.prototype.hasOwnProperty.call(value, 'output') : false
    const error = recordOf(value?.error)
    const errorDetail = error ? JSON.stringify(error) : value?.error === null ? 'null' : ''
    const statusDetail = status ? `; status: ${status}` : ''
    const outputDetail = hasOutputKey ? '; output: present but empty' : '; output: missing'
    return `response output is empty (keys: ${responseKeys || 'none'}${outputDetail}${statusDetail}${errorDetail ? `; error: ${errorDetail}` : ''})`
  }
  return `response output: ${output
    .slice(0, 8)
    .map(item => {
      const candidate = recordOf(item)
      return `${String(candidate?.type ?? 'unknown')}:${String(candidate?.name ?? '')}`
    })
    .join(', ')}`
}

function defaultFetcher(): typeof fetch {
  return shouldUseTauriFetch() ? (tauriFetch as typeof fetch) : globalThis.fetch.bind(globalThis)
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text()
  if (!text) return response.statusText || `HTTP ${response.status}`

  try {
    const parsed = JSON.parse(text)
    const error = parsed?.error
    if (typeof error?.message === 'string') return error.message
    if (typeof parsed?.message === 'string') return parsed.message
    if (typeof parsed?.detail === 'string') return parsed.detail
  } catch {
    return text
  }

  return text
}

export async function testLocalModelConnection(
  input: TestLocalModelConnectionInput,
  options: TestLocalModelConnectionOptions = {}
): Promise<TestLocalModelConnectionResult> {
  const apiFormat = normalizeLocalModelApiFormat(input.apiFormat)
  const requestUrl = buildLocalModelRequestUrl(input.baseUrl, input.requestPath, apiFormat)
  const modelId = normalizeLocalModelId(input.modelId)
  const apiKey = input.apiKey?.trim() || DUMMY_API_KEY
  const toolProfile = input.toolProfile ?? defaultLocalModelToolProfile(apiFormat)
  const fetcher = options.fetcher ?? defaultFetcher()
  const controller = new AbortController()
  const timeout = window.setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS
  )

  try {
    const response = await fetcher(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(apiFormat === 'anthropic-messages'
          ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
          : {}),
      },
      body: JSON.stringify(testRequestBody(apiFormat, modelId, toolProfile)),
      signal: controller.signal,
    })

    if (!response.ok) {
      const message = await readErrorMessage(response)
      throw new Error(`HTTP ${response.status}: ${message}`)
    }

    const body =
      apiFormat === 'openai-responses'
        ? await readResponsesProbeBody(response)
        : await response.json()
    if (!hasProbeToolCall(apiFormat, toolProfile, body)) {
      throw new Error(
        `Model did not return the required capability probe tool call (${summarizeProbeFailure(body)})`
      )
    }
    return { status: response.status, toolCalling: true }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Model test timed out', { cause: error })
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}
