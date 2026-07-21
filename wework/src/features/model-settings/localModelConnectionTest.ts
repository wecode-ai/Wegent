import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { shouldUseTauriFetch } from '@/api/http'
import {
  buildLocalModelRequestUrl,
  normalizeLocalModelApiFormat,
  normalizeLocalModelId,
  type LocalModelApiFormat,
} from './localModelSettings'

const DEFAULT_TEST_TIMEOUT_MS = 15_000
const DUMMY_API_KEY = 'dummy'

export interface TestLocalModelConnectionInput {
  baseUrl: string
  apiFormat?: LocalModelApiFormat | null
  requestPath?: string | null
  modelId: string
  apiKey?: string | null
}

export interface TestLocalModelConnectionOptions {
  fetcher?: typeof fetch
  timeoutMs?: number
}

export interface TestLocalModelConnectionResult {
  status: number
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
      body: JSON.stringify(
        apiFormat === 'anthropic-messages'
          ? {
              model: modelId,
              messages: [{ role: 'user', content: 'Reply with ok.' }],
              max_tokens: 16,
              stream: false,
            }
          : apiFormat === 'openai-chat-completions'
            ? {
                model: modelId,
                messages: [{ role: 'user', content: 'Reply with ok.' }],
                max_tokens: 16,
                stream: false,
              }
            : {
                model: modelId,
                input: [
                  {
                    role: 'user',
                    content: [{ type: 'input_text', text: 'Reply with ok.' }],
                  },
                ],
                max_output_tokens: 16,
                store: false,
              }
      ),
      signal: controller.signal,
    })

    if (!response.ok) {
      const message = await readErrorMessage(response)
      throw new Error(`HTTP ${response.status}: ${message}`)
    }

    return { status: response.status }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Model test timed out', { cause: error })
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}
