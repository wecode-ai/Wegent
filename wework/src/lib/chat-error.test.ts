import { describe, expect, test } from 'vitest'
import { parseChatError } from './chat-error'

describe('parseChatError', () => {
  test.each([
    ['context_length_exceeded', 'context_length_exceeded'],
    ['quota_exceeded', 'quota_exceeded'],
    ['rate_limit', 'rate_limit'],
    ['content_filter', 'content_filter'],
    ['permission_denied', 'permission_denied'],
    ['model_unavailable', 'llm_error'],
  ])('uses backend error type %s before keyword matching', (errorType, normalizedType) => {
    expect(parseChatError('raw backend message', errorType).type).toBe(normalizedType)
  })

  test('extracts backend error codes from JSON-shaped messages', () => {
    const parsed = parseChatError(
      'Task failed: {"error_code":"payload_too_large","message":"too much data"}'
    )

    expect(parsed.type).toBe('payload_too_large')
    expect(parsed.titleKey).toBe('assistant_error.types.payload_too_large.title')
  })

  test.each([
    ['maximum context length exceeded', 'context_length_exceeded'],
    ['data_inspection_failed: risky content', 'content_filter'],
    ['image size exceeds limit', 'image_too_large'],
    ['invalid role: user', 'invalid_role'],
    ['only claude models are supported', 'model_protocol_error'],
    ['out of memory', 'container_oom'],
    ['peer closed connection without response', 'network_error'],
    ['请求超时，请稍后重试', 'timeout_error'],
    [
      'API Error: 502 Bad Gateway. This is a server-side issue, usually temporary',
      'provider_error',
    ],
    [
      'API Error: 400 {"error":{"message":"模型 deepseek-v3.1 不支持 Anthropic 协议"}}',
      'model_protocol_error',
    ],
  ])('classifies %s as %s', (message, type) => {
    expect(parseChatError(message).type).toBe(type)
  })
})
