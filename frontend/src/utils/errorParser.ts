// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse error messages and return user-friendly error information.
 *
 * Supports backend-provided error types (preferred) with string-based
 * keyword matching as fallback.
 */

export type ErrorType =
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

export interface ParsedError {
  type: ErrorType
  message: string
  originalError?: string
  retryable?: boolean
}

// Valid backend error type values
const VALID_BACKEND_TYPES = new Set<string>([
  'context_length_exceeded',
  'quota_exceeded',
  'rate_limit',
  'llm_error',
  'model_unavailable',
  'container_oom',
  'container_error',
  'network_error',
  'timeout_error',
  'llm_unsupported',
  'forbidden',
  'payload_too_large',
  'invalid_parameter',
  'content_filter',
  'provider_error',
  'image_too_large',
  'model_protocol_error',
  'invalid_role',
  'permission_denied',
  'generic_error',
])

// Map backend error codes to frontend ErrorType
const BACKEND_TYPE_MAP: Record<string, ErrorType> = {
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

/**
 * Parse error and return structured error information.
 *
 * @param error - Error object or error message
 * @param backendType - Optional error type from backend classification
 * @returns Parsed error information
 */
export function parseError(error: Error | string, backendType?: string): ParsedError {
  const errorMessage = typeof error === 'string' ? error : error.message

  // Use backend-provided type if valid
  if (backendType && VALID_BACKEND_TYPES.has(backendType)) {
    const type = BACKEND_TYPE_MAP[backendType] || 'generic_error'
    return {
      type,
      message: errorMessage,
      originalError: errorMessage,
      retryable: true,
    }
  }

  // Fall back to keyword-based string matching
  return classifyByMessage(errorMessage)
}

/**
 * Classify error by keyword matching on the message string.
 */
function classifyByMessage(errorMessage: string): ParsedError {
  const lowerMessage = errorMessage.toLowerCase()

  // Context length exceeded (check before general LLM errors)
  if (
    lowerMessage.includes('prompt is too long') ||
    lowerMessage.includes('context_length_exceeded') ||
    lowerMessage.includes('context length exceeded') ||
    lowerMessage.includes('maximum context length') ||
    lowerMessage.includes('token limit exceeded') ||
    lowerMessage.includes('tokens exceeds the model') ||
    lowerMessage.includes('input is too long') ||
    lowerMessage.includes('maximum number of tokens')
  ) {
    return buildResult('context_length_exceeded', errorMessage)
  }

  // Content filter / safety moderation (check before generic 400 errors)
  if (
    lowerMessage.includes('data_inspection_failed') ||
    lowerMessage.includes('inappropriate content') ||
    lowerMessage.includes('content filter') ||
    lowerMessage.includes('content management') ||
    lowerMessage.includes('content_policy') ||
    lowerMessage.includes('contentfilter') ||
    lowerMessage.includes('risky content') ||
    lowerMessage.includes('content_filtering_policy') ||
    lowerMessage.includes('responsibleaipolicy') ||
    lowerMessage.includes('resp_safety_modify_answer')
  ) {
    return buildResult('content_filter', errorMessage)
  }

  // Image too large (check before generic payload errors)
  if (
    lowerMessage.includes('image exceeds') ||
    lowerMessage.includes('image too large') ||
    lowerMessage.includes('image size exceeds')
  ) {
    return buildResult('image_too_large', errorMessage)
  }

  // Invalid role in messages (model protocol mismatch)
  if (lowerMessage.includes('invalid role')) {
    return buildResult('invalid_role', errorMessage)
  }

  // Model protocol error (model ID not supported by provider)
  if (
    lowerMessage.includes('invalid model id') ||
    lowerMessage.includes('only claude') ||
    lowerMessage.includes('only thudm') ||
    lowerMessage.includes('only moonshot')
  ) {
    return buildResult('model_protocol_error', errorMessage)
  }

  // Container OOM
  if (
    lowerMessage.includes('out of memory') ||
    /\boom\b/.test(lowerMessage) ||
    lowerMessage.includes('memory allocation')
  ) {
    return buildResult('container_oom', errorMessage)
  }

  // Container/executor errors (includes Claude Code shell disconnections)
  if (
    lowerMessage.includes('container') ||
    lowerMessage.includes('executor') ||
    lowerMessage.includes('docker') ||
    lowerMessage.includes('disappeared unexpectedly') ||
    lowerMessage.includes('no ports mapped') ||
    lowerMessage.includes('crashed unexpectedly') ||
    lowerMessage.includes('exit code') ||
    lowerMessage.includes('device disconnected') ||
    lowerMessage.includes('not logged in')
  ) {
    return buildResult('container_error', errorMessage)
  }

  // Quota exceeded (check before rate_limit and permission — more specific)
  if (
    lowerMessage.includes('quota exceeded') ||
    lowerMessage.includes('insufficient_quota') ||
    lowerMessage.includes('billing') ||
    lowerMessage.includes('credit balance') ||
    lowerMessage.includes('payment required') ||
    lowerMessage.includes('insufficient funds') ||
    lowerMessage.includes('exceeded your current quota')
  ) {
    return buildResult('quota_exceeded', errorMessage)
  }

  // Rate limit (temporary throttling)
  if (
    lowerMessage.includes('rate limit') ||
    lowerMessage.includes('rate_limit') ||
    lowerMessage.includes('too many requests') ||
    lowerMessage.includes('throttl')
  ) {
    return buildResult('rate_limit', errorMessage)
  }

  // Permission denied (model access restrictions, check before generic forbidden)
  if (
    lowerMessage.includes('permission_denied') ||
    lowerMessage.includes('permission denied') ||
    lowerMessage.includes('permission_error')
  ) {
    return buildResult('permission_denied', errorMessage)
  }

  // Forbidden/unauthorized
  if (
    lowerMessage.includes('forbidden') ||
    lowerMessage.includes('not allowed') ||
    lowerMessage.includes('unauthorized') ||
    lowerMessage.includes('403')
  ) {
    return buildResult('forbidden', errorMessage)
  }

  // Provider error (model provider service wrapping)
  if (lowerMessage.includes('error from provider') || lowerMessage.includes('upstream error')) {
    return buildResult('provider_error', errorMessage)
  }

  // Model unsupported (multi-modal, incompatibility)
  if (
    lowerMessage.includes('multi-modal') ||
    lowerMessage.includes('multimodal') ||
    lowerMessage.includes('do not support') ||
    lowerMessage.includes('does not support') ||
    lowerMessage.includes('not support image') ||
    (lowerMessage.includes('llm model') && lowerMessage.includes('received'))
  ) {
    return buildResult('llm_unsupported', errorMessage)
  }

  // General LLM errors (model unavailable, API errors)
  if (
    lowerMessage.includes('model not found') ||
    lowerMessage.includes('model unavailable') ||
    lowerMessage.includes('llm request failed') ||
    lowerMessage.includes('llm api error') ||
    lowerMessage.includes('llm call failed') ||
    lowerMessage.includes('llm service error') ||
    lowerMessage.includes('model error') ||
    lowerMessage.includes('api rate limit') ||
    lowerMessage.includes('token limit')
  ) {
    return buildResult('llm_error', errorMessage)
  }

  // Invalid parameter
  if (lowerMessage.includes('invalid') && lowerMessage.includes('parameter')) {
    return buildResult('invalid_parameter', errorMessage)
  }

  // Payload too large
  if (lowerMessage.includes('413') || lowerMessage.includes('payload too large')) {
    return buildResult('payload_too_large', errorMessage)
  }

  // Timeout (includes gateway timeouts)
  if (
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('504 gateway') ||
    lowerMessage.includes('502 bad gateway') ||
    lowerMessage.includes('超时')
  ) {
    return buildResult('timeout_error', errorMessage)
  }

  // Network errors (includes upstream connection issues)
  if (
    lowerMessage.includes('network') ||
    lowerMessage.includes('fetch') ||
    lowerMessage.includes('connection') ||
    lowerMessage.includes('not connected') ||
    lowerMessage.includes('websocket') ||
    lowerMessage.includes('peer closed connection') ||
    lowerMessage.includes('upstream connection interrupted')
  ) {
    return buildResult('network_error', errorMessage)
  }

  // Generic fallback
  return buildResult('generic_error', errorMessage)
}

function buildResult(type: ErrorType, errorMessage: string): ParsedError {
  return {
    type,
    message: errorMessage,
    originalError: errorMessage,
    retryable: true,
  }
}

/**
 * Get user-friendly error message for display in toast/UI.
 *
 * Always returns an i18n-translated friendly message for ALL error types.
 * Raw error details are available separately via parseError().originalError
 * (shown in the expandable "Error Details" section of ErrorCard).
 *
 * @param error - Error object or error message
 * @param t - i18n translation function
 * @param backendType - Optional error type from backend classification
 */
export function getErrorDisplayMessage(
  error: Error | string,
  t: (key: string) => string,
  backendType?: string
): string {
  const parsed = parseError(error, backendType)

  switch (parsed.type) {
    case 'context_length_exceeded':
      return t('errors.context_length_exceeded')
    case 'quota_exceeded':
      return t('errors.quota_exceeded')
    case 'rate_limit':
      return t('errors.rate_limit')
    case 'forbidden':
      return t('errors.forbidden') || t('errors.generic_error')
    case 'container_oom':
      return t('errors.container_oom')
    case 'container_error':
      return t('errors.container_error')
    case 'llm_unsupported':
      return t('errors.llm_unsupported')
    case 'llm_error':
      return t('errors.llm_error')
    case 'invalid_parameter':
      return t('errors.invalid_parameter')
    case 'payload_too_large':
      return t('errors.payload_too_large')
    case 'network_error':
      return t('errors.network_error')
    case 'timeout_error':
      return t('errors.timeout_error')
    case 'content_filter':
      return t('errors.content_filter')
    case 'provider_error':
      return t('errors.provider_error')
    case 'image_too_large':
      return t('errors.image_too_large')
    case 'model_protocol_error':
      return t('errors.model_protocol_error')
    case 'invalid_role':
      return t('errors.invalid_role')
    case 'permission_denied':
      return t('errors.permission_denied')
    default:
      return t('errors.generic_error')
  }
}
