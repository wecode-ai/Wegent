import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { shouldUseTauriFetch } from '@/api/http'
import {
  buildLocalModelRequestUrl,
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
      tool_choice: { type: 'tool', name: PROBE_TOOL_NAME },
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
      tool_choice: { type: 'function', function: { name: PROBE_TOOL_NAME } },
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
  return {
    model,
    input: 'Call the capability probe with value PING.',
    max_output_tokens: 64,
    stream: false,
    store: false,
    tool_choice: custom
      ? { type: 'custom', name: PROBE_TOOL_NAME }
      : { type: 'function', name: PROBE_TOOL_NAME },
    tools: custom
      ? [
          {
            type: 'custom',
            name: PROBE_TOOL_NAME,
            description: 'Return the exact probe value.',
            format: { type: 'grammar', syntax: 'lark', definition: 'start: "PING"' },
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

function hasProbeToolCall(apiFormat: LocalModelApiFormat, body: unknown): boolean {
  const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  const value = record(body)
  if (!value) return false
  if (apiFormat === 'anthropic-messages') {
    return array(value.content).some(item => {
      const candidate = record(item)
      return candidate?.type === 'tool_use' && candidate.name === PROBE_TOOL_NAME
    })
  }
  if (apiFormat === 'openai-chat-completions') {
    return array(value.choices).some(choice => {
      const message = record(record(choice)?.message)
      return array(message?.tool_calls).some(call => {
        const fn = record(record(call)?.function)
        return fn?.name === PROBE_TOOL_NAME
      })
    })
  }
  return array(value.output).some(item => {
    const candidate = record(item)
    return (
      (candidate?.type === 'custom_tool_call' || candidate?.type === 'function_call') &&
      candidate.name === PROBE_TOOL_NAME
    )
  })
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
  const toolProfile =
    input.toolProfile ?? (apiFormat === 'openai-responses' ? 'custom' : 'function')
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

    const body = await response.json()
    if (!hasProbeToolCall(apiFormat, body)) {
      throw new Error('Model did not return the required capability probe tool call')
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
