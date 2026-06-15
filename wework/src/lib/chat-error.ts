export type ChatErrorType =
  | 'context_length_exceeded'
  | 'quota_exceeded'
  | 'rate_limit'
  | 'payload_too_large'
  | 'network_error'
  | 'timeout_error'
  | 'llm_error'
  | 'llm_unsupported'
  | 'invalid_parameter'
  | 'forbidden'
  | 'container_oom'
  | 'container_error'
  | 'content_filter'
  | 'provider_error'
  | 'image_too_large'
  | 'model_protocol_error'
  | 'invalid_role'
  | 'permission_denied'
  | 'generic_error'

export interface ParsedChatError {
  type: ChatErrorType
  titleKey: string
  descriptionKey: string
}

const BACKEND_TYPE_MAP: Record<string, ChatErrorType> = {
  context_length_exceeded: 'context_length_exceeded',
  quota_exceeded: 'quota_exceeded',
  rate_limit: 'rate_limit',
  llm_error: 'llm_error',
  model_unavailable: 'llm_error',
  container_oom: 'container_oom',
  container_error: 'container_error',
  network_error: 'network_error',
  timeout_error: 'timeout_error',
  llm_unsupported: 'llm_unsupported',
  forbidden: 'forbidden',
  payload_too_large: 'payload_too_large',
  invalid_parameter: 'invalid_parameter',
  content_filter: 'content_filter',
  provider_error: 'provider_error',
  image_too_large: 'image_too_large',
  model_protocol_error: 'model_protocol_error',
  invalid_role: 'invalid_role',
  permission_denied: 'permission_denied',
  generic_error: 'generic_error',
}

const CLASSIFICATION_RULES: Array<[ChatErrorType, Array<string | RegExp>]> = [
  [
    'context_length_exceeded',
    [
      'prompt is too long',
      'context_length_exceeded',
      'context length exceeded',
      'maximum context length',
      'max_tokens',
      'token limit exceeded',
      'tokens exceeds the model',
      'input is too long',
      'request too large',
      'maximum number of tokens',
    ],
  ],
  [
    'content_filter',
    [
      'data_inspection_failed',
      'inappropriate content',
      'content filter',
      'content management',
      'content_policy',
      'contentfilter',
      'risky content',
      'content_filtering_policy',
      'responsibleaipolicy',
      'resp_safety_modify_answer',
    ],
  ],
  ['image_too_large', ['image exceeds', 'image too large', 'image size exceeds']],
  ['invalid_role', ['invalid role']],
  [
    'model_protocol_error',
    [
      'invalid model id',
      'only claude',
      'only thudm',
      'only moonshot',
      'anthropic protocol',
      'anthropic 协议',
      '不支持 anthropic',
    ],
  ],
  ['container_oom', ['out of memory', /\boom\b/, 'oom killed', 'memory allocation']],
  [
    'container_error',
    [
      'container',
      'executor',
      'docker',
      'disappeared unexpectedly',
      'no ports mapped',
      'crashed unexpectedly',
      'exit code',
      'device disconnected',
      'not logged in',
    ],
  ],
  [
    'quota_exceeded',
    [
      'quota exceeded',
      'insufficient_quota',
      'billing',
      'credit balance',
      'payment required',
      'account balance',
      'insufficient funds',
      'exceeded your current quota',
    ],
  ],
  ['rate_limit', ['rate limit', 'rate_limit', 'too many requests', 'throttl']],
  ['permission_denied', ['permission_denied', 'permission denied', 'permission_error']],
  ['forbidden', ['forbidden', 'not allowed', 'unauthorized', '403']],
  ['provider_error', ['error from provider', 'upstream error']],
  [
    'llm_unsupported',
    ['multi-modal', 'multimodal', 'do not support', 'does not support', 'not support image'],
  ],
  [
    'llm_error',
    [
      'model not found',
      'model unavailable',
      'model_not_found',
      'model error',
      'overloaded',
      'llm request failed',
      'llm api error',
      'llm call failed',
      'llm service error',
    ],
  ],
  ['invalid_parameter', ['invalid parameter', 'invalid_parameter']],
  ['payload_too_large', ['413', 'payload too large']],
  ['timeout_error', ['timeout', 'timed out', '504 gateway', '502 bad gateway', '超时']],
  [
    'network_error',
    [
      'network',
      'fetch',
      'connection refused',
      'connection reset',
      'connection error',
      'not connected',
      'websocket',
      'peer closed connection',
      'upstream connection interrupted',
    ],
  ],
]

export function parseChatError(error: string, backendType?: string | null): ParsedChatError {
  const type =
    normalizeBackendType(backendType) ??
    normalizeBackendType(extractStructuredErrorType(error)) ??
    classifyByMessage(error)

  return {
    type,
    titleKey: `assistant_error.types.${type}.title`,
    descriptionKey: `assistant_error.types.${type}.description`,
  }
}

function normalizeBackendType(type?: string | null): ChatErrorType | undefined {
  if (!type) return undefined
  return BACKEND_TYPE_MAP[type.trim()] ?? BACKEND_TYPE_MAP[type.trim().toLowerCase()]
}

function classifyByMessage(message: string): ChatErrorType {
  const lowerMessage = message.toLowerCase()
  for (const [type, patterns] of CLASSIFICATION_RULES) {
    if (
      patterns.some(pattern =>
        typeof pattern === 'string' ? lowerMessage.includes(pattern) : pattern.test(lowerMessage),
      )
    ) {
      return type
    }
  }

  return 'generic_error'
}

function extractStructuredErrorType(message: string): string | undefined {
  const candidates = extractJsonObjects(message)
  for (const candidate of candidates) {
    const type = findErrorType(candidate)
    if (type) return type
  }

  return undefined
}

function extractJsonObjects(message: string): unknown[] {
  const objects: unknown[] = []
  const startIndexes: number[] = []

  for (let index = 0; index < message.length; index += 1) {
    if (message[index] === '{') {
      startIndexes.push(index)
    }
  }

  for (const start of startIndexes) {
    const parsed = tryParseJsonSuffix(message.slice(start))
    if (parsed !== undefined) {
      objects.push(parsed)
    }
  }

  return objects
}

function tryParseJsonSuffix(text: string): unknown {
  for (let end = text.length; end > 0; end -= 1) {
    const candidate = text.slice(0, end).trim()
    if (!candidate.endsWith('}')) continue

    try {
      return JSON.parse(candidate)
    } catch {
      // Continue trimming until the embedded JSON object boundary is found.
    }
  }

  return undefined
}

function findErrorType(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>

  for (const key of ['error_type', 'error_code', 'type', 'code']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && normalizeBackendType(candidate)) {
      return candidate
    }
  }

  for (const nested of Object.values(record)) {
    const nestedType = findErrorType(nested)
    if (nestedType) return nestedType
  }

  return undefined
}
