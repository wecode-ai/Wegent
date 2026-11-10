// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { parseChatError } from './chat-error'

describe('parseChatError', () => {
  test('uses executor Git diagnostics instead of classifying them as model errors', () => {
    const failure = {
      code: 'credentials-required',
      domain: 'git.example:8443',
      message: 'Configure Git',
    }
    const parsed = parseChatError(
      `Checkout failed: git-access:${JSON.stringify(failure)}`,
      'container_error'
    )
    expect(parsed.gitFailure).toEqual(failure)
    expect(parsed.descriptionKey).toBe('assistant_error.git_access.credentials-required')
  })

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

  test('reports the model service endpoint when the local proxy cannot connect', () => {
    const parsed = parseChatError(
      'unexpected status 502 Bad Gateway: {"detail":"Local model proxy request failed: error sending request for url (https://model-gateway.example.internal/api/runtime-work/llm-responses-proxy/responses)"}'
    )

    expect(parsed.type).toBe('model_service_connection_error')
    expect(parsed.endpoint).toBe(
      'https://model-gateway.example.internal/api/runtime-work/llm-responses-proxy/responses'
    )
  })
})
