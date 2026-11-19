// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Classify chat errors using explicit backend codes before legacy messages. */
export type ErrorCategory =
  | 'model'
  | 'input'
  | 'access'
  | 'policy'
  | 'runtime'
  | 'tool'
  | 'transport'
  | 'platform'
  | 'unknown'

export type RetryPolicy = 'after_backoff' | 'after_change' | 'none' | 'unknown'

const ERROR_DEFINITIONS = {
  context_length_exceeded: { category: 'input', retryPolicy: 'after_change' },
  quota_exceeded: { category: 'model', retryPolicy: 'after_change' },
  rate_limit: { category: 'model', retryPolicy: 'after_backoff' },
  server_overloaded: { category: 'model', retryPolicy: 'after_backoff' },
  payload_too_large: { category: 'input', retryPolicy: 'after_change' },
  network_error: { category: 'transport', retryPolicy: 'after_backoff' },
  timeout_error: { category: 'transport', retryPolicy: 'after_backoff' },
  llm_error: { category: 'model', retryPolicy: 'after_backoff' },
  llm_unsupported: { category: 'input', retryPolicy: 'after_change' },
  invalid_parameter: { category: 'input', retryPolicy: 'after_change' },
  forbidden: { category: 'access', retryPolicy: 'after_change' },
  authentication_expired: { category: 'access', retryPolicy: 'after_change' },
  container_oom: { category: 'runtime', retryPolicy: 'after_change' },
  container_error: { category: 'runtime', retryPolicy: 'after_change' },
  skills_unmanaged_entries: { category: 'runtime', retryPolicy: 'after_change' },
  skill_deploy_failed: { category: 'runtime', retryPolicy: 'after_change' },
  executor_start_failed: { category: 'runtime', retryPolicy: 'after_change' },
  workspace_unavailable: { category: 'runtime', retryPolicy: 'after_change' },
  content_filter: { category: 'policy', retryPolicy: 'after_change' },
  provider_error: { category: 'model', retryPolicy: 'after_backoff' },
  image_too_large: { category: 'input', retryPolicy: 'after_change' },
  model_protocol_error: { category: 'input', retryPolicy: 'after_change' },
  invalid_role: { category: 'input', retryPolicy: 'after_change' },
  permission_denied: { category: 'access', retryPolicy: 'after_change' },
  tool_execution_failed: { category: 'tool', retryPolicy: 'unknown' },
  connector_unavailable: { category: 'tool', retryPolicy: 'after_backoff' },
  plugin_load_failed: { category: 'tool', retryPolicy: 'after_change' },
  stream_protocol_error: { category: 'transport', retryPolicy: 'after_backoff' },
  internal_error: { category: 'platform', retryPolicy: 'after_backoff' },
  storage_error: { category: 'platform', retryPolicy: 'after_backoff' },
  dispatch_error: { category: 'platform', retryPolicy: 'after_backoff' },
  generic_error: { category: 'unknown', retryPolicy: 'unknown' },
} as const satisfies Record<string, { category: ErrorCategory; retryPolicy: RetryPolicy }>

export type ErrorType = keyof typeof ERROR_DEFINITIONS

export type ErrorInfo = import('@wegent/chat-core').ChatErrorInfo

export interface ParsedError {
  type: ErrorType
  category: ErrorCategory
  retryPolicy: RetryPolicy
  message: string
  originalError?: string
  retryable?: boolean
}

function backendErrorType(code?: string): ErrorType | undefined {
  const normalized = code?.trim()
  if (normalized === 'model_unavailable') {
    return 'llm_error'
  }
  return normalized && Object.prototype.hasOwnProperty.call(ERROR_DEFINITIONS, normalized)
    ? (normalized as ErrorType)
    : undefined
}

/** Explicit causes prevail; a generic code can be refined from a known message. */
export function parseError(
  error: Error | string,
  backendType?: string,
  errorInfo?: ErrorInfo
): ParsedError {
  const errorMessage = typeof error === 'string' ? error : error.message
  const backendTypeValue = backendErrorType(errorInfo?.code) ?? backendErrorType(backendType)
  const messageType = classifyByMessage(errorMessage)
  const type =
    backendTypeValue && backendTypeValue !== 'generic_error' && backendTypeValue !== 'llm_error'
      ? backendTypeValue
      : messageType === 'generic_error' && backendTypeValue === 'llm_error'
        ? 'llm_error'
        : messageType
  const definition = ERROR_DEFINITIONS[type]
  const retryPolicy = isRetryPolicy(errorInfo?.retry_policy)
    ? errorInfo.retry_policy
    : definition.retryPolicy

  return {
    type,
    category: definition.category,
    retryPolicy,
    message: errorMessage,
    originalError: errorMessage,
    // Unknown causes retain the manual retry action without claiming recovery.
    retryable: retryPolicy === 'after_backoff' || retryPolicy === 'unknown',
  }
}

function isRetryPolicy(policy: unknown): policy is RetryPolicy {
  return ['after_backoff', 'after_change', 'none', 'unknown'].includes(policy as string)
}

const MESSAGE_RULES: ReadonlyArray<readonly [ErrorType, ReadonlyArray<string | RegExp>]> = [
  ['skills_unmanaged_entries', ['agent skills directory contains unmanaged entries']],
  [
    'context_length_exceeded',
    [
      'prompt is too long',
      'context_length_exceeded',
      'context length exceeded',
      'maximum context length',
      'token limit exceeded',
      'tokens exceeds the model',
      'input is too long',
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
  ['model_protocol_error', ['invalid model id', 'only claude', 'only thudm', 'only moonshot']],
  [
    'quota_exceeded',
    [
      '商业付费模型额度已用完',
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
  ['server_overloaded', ['server_overloaded', 'server overloaded', 'serveroverloaded']],
  [
    'authentication_expired',
    ['authentication_expired', 'authentication expired', 'credentials expired', 'not logged in'],
  ],
  [
    'permission_denied',
    [
      '无权限调用此模型',
      '禁止使用外部模型',
      'permission_denied',
      'permission denied',
      'permission_error',
    ],
  ],
  ['forbidden', ['forbidden', 'not allowed', 'unauthorized', /\b403\b/]],
  // A transport cause remains informative even inside an executor/provider wrapper.
  ['timeout_error', ['timeout', 'timed out', '504 gateway', '超时']],
  [
    'network_error',
    [
      'network',
      'fetch failed',
      'connection refused',
      'connection reset',
      'connection error',
      'connection failed',
      'not connected',
      'websocket',
      'peer closed connection',
      'upstream connection interrupted',
    ],
  ],
  ['provider_error', ['error from provider', 'upstream error', '502 bad gateway']],
  [
    'llm_unsupported',
    [
      'multi-modal',
      'multimodal',
      'do not support',
      'does not support',
      'not support image',
      /llm model.*received/,
    ],
  ],
  [
    'llm_error',
    [
      'model not found',
      'model unavailable',
      'llm request failed',
      'llm api error',
      'llm call failed',
      'llm service error',
      'model error',
      'token limit',
    ],
  ],
  ['invalid_parameter', [/invalid.*parameter/]],
  ['payload_too_large', [/\b413\b/, 'payload too large']],
  ['container_oom', ['out of memory', /\boom\b/, 'memory allocation']],
  ['skill_deploy_failed', ['skill deployment failed', 'failed to deploy skill']],
  ['executor_start_failed', ['executor start failed', 'failed to start executor']],
  ['workspace_unavailable', ['workspace unavailable', 'workspace not found']],
  ['tool_execution_failed', ['tool execution failed']],
  ['connector_unavailable', ['connector unavailable']],
  ['plugin_load_failed', ['plugin load failed', 'failed to load plugin']],
  ['stream_protocol_error', ['stream protocol error']],
  ['internal_error', ['internal_error', 'internal server error']],
  ['storage_error', ['storage_error', 'storage error']],
  ['dispatch_error', ['dispatch_error', 'dispatch failed']],
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
    ],
  ],
]

function classifyByMessage(errorMessage: string): ErrorType {
  const lowerMessage = errorMessage.toLowerCase()
  for (const [type, patterns] of MESSAGE_RULES) {
    if (
      patterns.some(pattern =>
        typeof pattern === 'string' ? lowerMessage.includes(pattern) : pattern.test(lowerMessage)
      )
    ) {
      return type
    }
  }
  return 'generic_error'
}

/** Raw details remain available separately in the expandable ErrorCard details. */
export function getErrorDisplayMessage(
  error: Error | string,
  t: (key: string) => string,
  backendType?: string
): string {
  return t('errors.' + parseError(error, backendType).type)
}
