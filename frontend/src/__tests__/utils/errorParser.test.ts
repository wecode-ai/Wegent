// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  parseError,
  getUserFriendlyErrorMessage,
  getErrorDisplayMessage,
} from '@/utils/errorParser'

describe('errorParser', () => {
  describe('parseError', () => {
    describe('forbidden/unauthorized errors', () => {
      it('should detect forbidden errors', () => {
        const error = new Error('forbidden')
        const result = parseError(error)
        expect(result.type).toBe('forbidden')
        expect(result.retryable).toBe(false)
      })

      it('should detect not allowed errors', () => {
        const result = parseError('Request not allowed')
        expect(result.type).toBe('forbidden')
        expect(result.retryable).toBe(false)
      })

      it('should detect unauthorized errors', () => {
        const result = parseError('unauthorized access')
        expect(result.type).toBe('forbidden')
        expect(result.retryable).toBe(false)
      })

      it('should detect 403 errors', () => {
        const result = parseError('403 Forbidden')
        expect(result.type).toBe('forbidden')
        expect(result.retryable).toBe(false)
      })
    })

    describe('model unsupported errors', () => {
      it('should detect multi-modal errors', () => {
        const result = parseError('multi-modal not supported')
        expect(result.type).toBe('llm_unsupported')
        expect(result.retryable).toBe(false)
      })

      it('should detect multimodal errors (no hyphen)', () => {
        const result = parseError('multimodal content not supported')
        expect(result.type).toBe('llm_unsupported')
        expect(result.retryable).toBe(false)
      })

      it('should detect llm model mismatch errors', () => {
        const result = parseError('llm model expected but received')
        expect(result.type).toBe('llm_unsupported')
        expect(result.retryable).toBe(false)
      })

      it('should detect "do not support" errors', () => {
        const result = parseError('Model do not support image input')
        expect(result.type).toBe('llm_unsupported')
        expect(result.retryable).toBe(false)
      })

      it('should detect "does not support" errors', () => {
        const result = parseError('This model does not support image processing')
        expect(result.type).toBe('llm_unsupported')
        expect(result.retryable).toBe(false)
      })

      it('should detect image not supported errors', () => {
        const result = parseError('Model not support image input')
        expect(result.type).toBe('llm_unsupported')
        expect(result.retryable).toBe(false)
      })
    })

    describe('general LLM errors', () => {
      it('should detect model not found errors', () => {
        const result = parseError('model not found')
        expect(result.type).toBe('llm_error')
        expect(result.retryable).toBe(true)
      })

      it('should detect model unavailable errors', () => {
        const result = parseError('model unavailable')
        expect(result.type).toBe('llm_error')
        expect(result.retryable).toBe(true)
      })

      it('should detect llm service error', () => {
        const result = parseError('llm service error')
        expect(result.type).toBe('llm_error')
        expect(result.retryable).toBe(true)
      })

      it('should detect llm request failed errors', () => {
        const result = parseError('llm request failed')
        expect(result.type).toBe('llm_error')
        expect(result.retryable).toBe(true)
      })

      it('should detect llm api error', () => {
        const result = parseError('llm api error occurred')
        expect(result.type).toBe('llm_error')
        expect(result.retryable).toBe(true)
      })

      it('should detect llm call failed errors', () => {
        const result = parseError('llm call failed')
        expect(result.type).toBe('llm_error')
        expect(result.retryable).toBe(true)
      })

      it('should detect model error', () => {
        const result = parseError('model error: invalid response')
        expect(result.type).toBe('llm_error')
        expect(result.retryable).toBe(true)
      })

      it('should detect api rate limit errors', () => {
        const result = parseError('api rate limit exceeded')
        expect(result.type).toBe('llm_error')
        expect(result.retryable).toBe(true)
      })

      it('should detect quota exceeded errors', () => {
        const result = parseError('quota exceeded for this model')
        expect(result.type).toBe('llm_error')
        expect(result.retryable).toBe(true)
      })

      it('should detect token limit errors', () => {
        const result = parseError('token limit reached')
        expect(result.type).toBe('llm_error')
        expect(result.retryable).toBe(true)
      })

      it('should NOT detect "llm" substring in unrelated errors as llm_error', () => {
        // This tests the fix: model_category_type="llm" should not trigger llm_error
        const result = parseError('Task failed: {"model_category_type": "llm"}')
        expect(result.type).toBe('generic_error')
        expect(result.retryable).toBe(true)
      })

      it('should NOT detect backend response with llm field as llm_error', () => {
        const result = parseError('Error processing request with llm configuration')
        expect(result.type).toBe('generic_error')
      })
    })

    describe('invalid parameter errors', () => {
      it('should detect invalid parameter errors', () => {
        const result = parseError('invalid parameter provided')
        expect(result.type).toBe('invalid_parameter')
        expect(result.retryable).toBe(true)
      })
    })

    describe('payload too large errors', () => {
      it('should detect 413 errors', () => {
        const result = parseError('413 Payload Too Large')
        expect(result.type).toBe('payload_too_large')
        expect(result.retryable).toBe(true)
      })

      it('should detect payload too large text', () => {
        const result = parseError('payload too large')
        expect(result.type).toBe('payload_too_large')
        expect(result.retryable).toBe(true)
      })
    })

    describe('network errors', () => {
      it('should detect network errors', () => {
        const result = parseError('network error occurred')
        expect(result.type).toBe('network_error')
        expect(result.retryable).toBe(true)
      })

      it('should detect fetch errors', () => {
        const result = parseError('fetch failed')
        expect(result.type).toBe('network_error')
        expect(result.retryable).toBe(true)
      })

      it('should detect connection errors', () => {
        const result = parseError('connection refused')
        expect(result.type).toBe('network_error')
        expect(result.retryable).toBe(true)
      })

      it('should detect WebSocket not connected errors', () => {
        const result = parseError('WebSocket not connected')
        expect(result.type).toBe('network_error')
        expect(result.retryable).toBe(true)
      })

      it('should detect websocket errors', () => {
        const result = parseError('websocket closed unexpectedly')
        expect(result.type).toBe('network_error')
        expect(result.retryable).toBe(true)
      })
    })

    describe('timeout errors', () => {
      it('should detect timeout errors', () => {
        const result = parseError('timeout error')
        expect(result.type).toBe('timeout_error')
        expect(result.retryable).toBe(true)
      })

      it('should detect timed out errors', () => {
        const result = parseError('request timed out')
        expect(result.type).toBe('timeout_error')
        expect(result.retryable).toBe(true)
      })
    })

    describe('generic errors', () => {
      it('should classify unknown errors as generic', () => {
        const result = parseError('some random error')
        expect(result.type).toBe('generic_error')
        expect(result.retryable).toBe(true)
      })

      it('should handle Error objects', () => {
        const error = new Error('unknown error')
        const result = parseError(error)
        expect(result.type).toBe('generic_error')
        expect(result.message).toBe('unknown error')
      })

      it('should handle string errors', () => {
        const result = parseError('string error message')
        expect(result.type).toBe('generic_error')
        expect(result.message).toBe('string error message')
      })
    })

    describe('edge cases', () => {
      it('should handle empty string errors', () => {
        const result = parseError('')
        expect(result.type).toBe('generic_error')
        expect(result.message).toBe('')
      })

      it('should handle errors with special characters', () => {
        const result = parseError('Error: <script>alert("xss")</script>')
        expect(result.type).toBe('generic_error')
        expect(result.originalError).toBe('Error: <script>alert("xss")</script>')
      })

      it('should handle very long error messages', () => {
        const longMessage = 'a'.repeat(10000)
        const result = parseError(longMessage)
        expect(result.type).toBe('generic_error')
        expect(result.message).toBe(longMessage)
      })

      it('should handle errors with newlines and tabs', () => {
        const result = parseError('Error:\n\tSome details\n\tMore info')
        expect(result.type).toBe('generic_error')
      })

      it('should handle JSON-formatted error messages', () => {
        const jsonError = '{"error": "something went wrong", "code": 500}'
        const result = parseError(jsonError)
        expect(result.type).toBe('generic_error')
      })
    })

    describe('real-world scenarios', () => {
      it('should detect model not support image from DeepSeek API response', () => {
        // Real error from DeepSeek API
        const error =
          'data: {"error":{"code":null,"message":"{\\"error\\":{\\"code\\":\\"InvalidParameter\\",\\"message\\":\\"Model do not support image input. Request id: 021768537375878a77eec5e653ab4759e46069478d0f365166e60\\",\\"param\\":\\"image_url\\",\\"type\\":\\"BadRequest\\"}}, model_id: DeepSeek-V3.2-251201","param":null,"type":"api_error"}}"'
        const result = parseError(error)
        expect(result.type).toBe('llm_unsupported')
        expect(result.retryable).toBe(false)
      })

      it('should detect peer closed connection as network error', () => {
        const error = 'peer closed connection without sending complete message body'
        const result = parseError(error)
        expect(result.type).toBe('network_error')
        expect(result.retryable).toBe(true)
      })

      it('should detect Team not found as generic error', () => {
        const error = 'Team not found'
        const result = parseError(error)
        expect(result.type).toBe('generic_error')
        expect(result.originalError).toBe('Team not found')
      })

      it('should detect WebSocket not connected error', () => {
        const error = 'WebSocket not connected'
        const result = parseError(error)
        expect(result.type).toBe('network_error')
        expect(result.retryable).toBe(true)
      })

      it('should NOT detect model_category_type="llm" as LLM error', () => {
        // This is a field value, not an actual LLM error
        const error =
          'Task failed: {"model_category_type": "llm", "status": "error", "detail": "processing failed"}'
        const result = parseError(error)
        expect(result.type).toBe('generic_error')
      })
    })

    describe('case insensitivity', () => {
      it('should handle uppercase errors', () => {
        const result = parseError('FORBIDDEN')
        expect(result.type).toBe('forbidden')
      })

      it('should handle mixed case errors', () => {
        const result = parseError('Network Error')
        expect(result.type).toBe('network_error')
      })
    })

    describe('priority of error detection', () => {
      it('should detect forbidden before other types', () => {
        // forbidden check comes first, so even if message contains "llm",
        // forbidden should take precedence
        const result = parseError('forbidden llm service error')
        expect(result.type).toBe('forbidden')
      })

      it('should detect llm_unsupported before llm_error', () => {
        // multi-modal check comes before general llm check
        const result = parseError('multimodal llm service error')
        expect(result.type).toBe('llm_unsupported')
      })
    })
  })

  describe('getUserFriendlyErrorMessage', () => {
    const mockT = (key: string) => {
      const translations: Record<string, string> = {
        'errors.forbidden': 'Access forbidden',
        'errors.model_unsupported': 'Model not supported',
        'errors.llm_unsupported': 'LLM unsupported',
        'errors.llm_error': 'LLM error',
        'errors.invalid_parameter': 'Invalid parameter',
        'errors.payload_too_large': 'Payload too large',
        'errors.network_error': 'Network error',
        'errors.timeout_error': 'Timeout error',
        'errors.generic_error': 'Generic error',
      }
      return translations[key] || key
    }

    it('should return friendly message for forbidden errors', () => {
      const message = getUserFriendlyErrorMessage('forbidden', mockT)
      expect(message).toBe('Access forbidden')
    })

    it('should return friendly message for llm_unsupported errors', () => {
      const message = getUserFriendlyErrorMessage('multimodal not supported', mockT)
      expect(message).toBe('LLM unsupported')
    })

    it('should return friendly message for llm_error', () => {
      const message = getUserFriendlyErrorMessage('model unavailable', mockT)
      expect(message).toBe('LLM error')
    })

    it('should return friendly message for invalid_parameter', () => {
      const message = getUserFriendlyErrorMessage('invalid parameter', mockT)
      expect(message).toBe('Invalid parameter')
    })

    it('should return friendly message for payload_too_large', () => {
      const message = getUserFriendlyErrorMessage('413 error', mockT)
      expect(message).toBe('Payload too large')
    })

    it('should return friendly message for network_error', () => {
      const message = getUserFriendlyErrorMessage('network failed', mockT)
      expect(message).toBe('Network error')
    })

    it('should return friendly message for timeout_error', () => {
      const message = getUserFriendlyErrorMessage('timeout', mockT)
      expect(message).toBe('Timeout error')
    })

    it('should return friendly message for generic_error', () => {
      const message = getUserFriendlyErrorMessage('unknown error', mockT)
      expect(message).toBe('Generic error')
    })

    it('should handle Error objects', () => {
      const error = new Error('network error')
      const message = getUserFriendlyErrorMessage(error, mockT)
      expect(message).toBe('Network error')
    })
  })

  describe('getErrorDisplayMessage', () => {
    const mockT = (key: string) => {
      const translations: Record<string, string> = {
        'errors.forbidden': 'Access forbidden',
        'errors.llm_unsupported': 'LLM unsupported',
        'errors.llm_error': 'LLM error',
        'errors.invalid_parameter': 'Invalid parameter',
        'errors.payload_too_large': 'Payload too large',
        'errors.network_error': 'Network error',
        'errors.timeout_error': 'Timeout error',
        'errors.generic_error': 'Generic error',
      }
      return translations[key] || key
    }

    describe('specific error types should return friendly messages', () => {
      it('should return friendly message for network errors', () => {
        const message = getErrorDisplayMessage('WebSocket not connected', mockT)
        expect(message).toBe('Network error')
      })

      it('should return friendly message for timeout errors', () => {
        const message = getErrorDisplayMessage('request timed out', mockT)
        expect(message).toBe('Timeout error')
      })

      it('should return friendly message for llm_unsupported errors', () => {
        const message = getErrorDisplayMessage('Model do not support image input', mockT)
        expect(message).toBe('LLM unsupported')
      })

      it('should return friendly message for llm_error', () => {
        const message = getErrorDisplayMessage('model unavailable', mockT)
        expect(message).toBe('LLM error')
      })

      it('should return friendly message for forbidden errors', () => {
        const message = getErrorDisplayMessage('forbidden', mockT)
        expect(message).toBe('Access forbidden')
      })
    })

    describe('generic errors should return original error message', () => {
      it('should return original error for "Team not found"', () => {
        const message = getErrorDisplayMessage('Team not found', mockT)
        expect(message).toBe('Team not found')
      })

      it('should return original error for business errors', () => {
        const message = getErrorDisplayMessage('User does not have permission', mockT)
        expect(message).toBe('User does not have permission')
      })

      it('should return original error for unknown errors', () => {
        const message = getErrorDisplayMessage('Something went wrong', mockT)
        expect(message).toBe('Something went wrong')
      })

      it('should return fallback message when original error is empty', () => {
        const message = getErrorDisplayMessage('', mockT, 'Fallback message')
        expect(message).toBe('Fallback message')
      })

      it('should return generic_error translation when no fallback provided', () => {
        const message = getErrorDisplayMessage('', mockT)
        expect(message).toBe('Generic error')
      })
    })

    describe('real-world scenarios from useChatStreamHandlers', () => {
      it('should handle WebSocket disconnect error', () => {
        const message = getErrorDisplayMessage('WebSocket not connected', mockT)
        expect(message).toBe('Network error')
      })

      it('should handle peer closed connection error', () => {
        const message = getErrorDisplayMessage(
          'peer closed connection without sending complete message body',
          mockT
        )
        expect(message).toBe('Network error')
      })

      it('should handle DeepSeek API model unsupported error', () => {
        const error = 'data: {"error":{"message":"Model do not support image input"}}'
        const message = getErrorDisplayMessage(error, mockT)
        expect(message).toBe('LLM unsupported')
      })

      it('should handle Team not found as original error', () => {
        const message = getErrorDisplayMessage('Team not found', mockT)
        expect(message).toBe('Team not found')
      })

      it('should handle Error objects', () => {
        const error = new Error('connection refused')
        const message = getErrorDisplayMessage(error, mockT)
        expect(message).toBe('Network error')
      })
    })
  })
})
