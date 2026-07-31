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
  return {
    model,
    input: custom
      ? `Call apply_patch with this exact patch:\n${APPLY_PATCH_PROBE}`
      : 'Call the capability probe with value PING.',
    max_output_tokens: 64,
    stream: false,
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

function hasProbeToolCall(
  apiFormat: LocalModelApiFormat,
  toolProfile: LocalModelToolProfile,
  body: unknown
): boolean {
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
  const expectedToolName = toolProfile === 'custom' ? APPLY_PATCH_TOOL_NAME : PROBE_TOOL_NAME
  return array(value.output).some(item => {
    const candidate = record(item)
    return (
      (candidate?.type === 'custom_tool_call' || candidate?.type === 'function_call') &&
      candidate.name === expectedToolName &&
      (toolProfile !== 'custom' || candidate.input === APPLY_PATCH_PROBE)
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

    let body: unknown
    try {
      body = await response.json()
    } catch (parseError) {
      throw new Error('Model returned a non-JSON response body', { cause: parseError })
    }
    if (!hasProbeToolCall(apiFormat, toolProfile, body)) {
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
