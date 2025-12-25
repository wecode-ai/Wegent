// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { parseError, getUserFriendlyErrorMessage } from '../errorParser';

describe('errorParser', () => {
  describe('parseError', () => {
    describe('forbidden/unauthorized errors', () => {
      it('should detect forbidden errors', () => {
        const error = new Error('forbidden');
        const result = parseError(error);
        expect(result.type).toBe('forbidden');
        expect(result.retryable).toBe(false);
      });

      it('should detect not allowed errors', () => {
        const result = parseError('Request not allowed');
        expect(result.type).toBe('forbidden');
        expect(result.retryable).toBe(false);
      });

      it('should detect unauthorized errors', () => {
        const result = parseError('unauthorized access');
        expect(result.type).toBe('forbidden');
        expect(result.retryable).toBe(false);
      });

      it('should detect 403 errors', () => {
        const result = parseError('403 Forbidden');
        expect(result.type).toBe('forbidden');
        expect(result.retryable).toBe(false);
      });
    });

    describe('model unsupported errors', () => {
      it('should detect multi-modal errors', () => {
        const result = parseError('multi-modal not supported');
        expect(result.type).toBe('llm_unsupported');
        expect(result.retryable).toBe(false);
      });

      it('should detect multimodal errors (no hyphen)', () => {
        const result = parseError('multimodal content not supported');
        expect(result.type).toBe('llm_unsupported');
        expect(result.retryable).toBe(false);
      });

      it('should detect llm model mismatch errors', () => {
        const result = parseError('llm model expected but received');
        expect(result.type).toBe('llm_unsupported');
        expect(result.retryable).toBe(false);
      });
    });

    describe('general LLM errors', () => {
      it('should detect model not found errors', () => {
        const result = parseError('model not found');
        expect(result.type).toBe('llm_error');
        expect(result.retryable).toBe(true);
      });

      it('should detect model unavailable errors', () => {
        const result = parseError('model unavailable');
        expect(result.type).toBe('llm_error');
        expect(result.retryable).toBe(true);
      });

      it('should detect generic llm errors', () => {
        const result = parseError('llm service error');
        expect(result.type).toBe('llm_error');
        expect(result.retryable).toBe(true);
      });
    });

    describe('invalid parameter errors', () => {
      it('should detect invalid parameter errors', () => {
        const result = parseError('invalid parameter provided');
        expect(result.type).toBe('invalid_parameter');
        expect(result.retryable).toBe(true);
      });
    });

    describe('payload too large errors', () => {
      it('should detect 413 errors', () => {
        const result = parseError('413 Payload Too Large');
        expect(result.type).toBe('payload_too_large');
        expect(result.retryable).toBe(true);
      });

      it('should detect payload too large text', () => {
        const result = parseError('payload too large');
        expect(result.type).toBe('payload_too_large');
        expect(result.retryable).toBe(true);
      });
    });

    describe('network errors', () => {
      it('should detect network errors', () => {
        const result = parseError('network error occurred');
        expect(result.type).toBe('network_error');
        expect(result.retryable).toBe(true);
      });

      it('should detect fetch errors', () => {
        const result = parseError('fetch failed');
        expect(result.type).toBe('network_error');
        expect(result.retryable).toBe(true);
      });

      it('should detect connection errors', () => {
        const result = parseError('connection refused');
        expect(result.type).toBe('network_error');
        expect(result.retryable).toBe(true);
      });
    });

    describe('timeout errors', () => {
      it('should detect timeout errors', () => {
        const result = parseError('timeout error');
        expect(result.type).toBe('timeout_error');
        expect(result.retryable).toBe(true);
      });

      it('should detect timed out errors', () => {
        const result = parseError('request timed out');
        expect(result.type).toBe('timeout_error');
        expect(result.retryable).toBe(true);
      });
    });

    describe('generic errors', () => {
      it('should classify unknown errors as generic', () => {
        const result = parseError('some random error');
        expect(result.type).toBe('generic_error');
        expect(result.retryable).toBe(true);
      });

      it('should handle Error objects', () => {
        const error = new Error('unknown error');
        const result = parseError(error);
        expect(result.type).toBe('generic_error');
        expect(result.message).toBe('unknown error');
      });

      it('should handle string errors', () => {
        const result = parseError('string error message');
        expect(result.type).toBe('generic_error');
        expect(result.message).toBe('string error message');
      });
    });

    describe('case insensitivity', () => {
      it('should handle uppercase errors', () => {
        const result = parseError('FORBIDDEN');
        expect(result.type).toBe('forbidden');
      });

      it('should handle mixed case errors', () => {
        const result = parseError('Network Error');
        expect(result.type).toBe('network_error');
      });
    });

    describe('priority of error detection', () => {
      it('should detect forbidden before other types', () => {
        // forbidden check comes first, so even if message contains "llm",
        // forbidden should take precedence
        const result = parseError('forbidden llm access');
        expect(result.type).toBe('forbidden');
      });

      it('should detect llm_unsupported before llm_error', () => {
        // multi-modal check comes before general llm check
        const result = parseError('multimodal llm error');
        expect(result.type).toBe('llm_unsupported');
      });
    });
  });

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
      };
      return translations[key] || key;
    };

    it('should return friendly message for forbidden errors', () => {
      const message = getUserFriendlyErrorMessage('forbidden', mockT);
      expect(message).toBe('Model not supported');
    });

    it('should return friendly message for llm_unsupported errors', () => {
      const message = getUserFriendlyErrorMessage('multimodal not supported', mockT);
      expect(message).toBe('LLM unsupported');
    });

    it('should return friendly message for llm_error', () => {
      const message = getUserFriendlyErrorMessage('model unavailable', mockT);
      expect(message).toBe('LLM error');
    });

    it('should return friendly message for invalid_parameter', () => {
      const message = getUserFriendlyErrorMessage('invalid parameter', mockT);
      expect(message).toBe('Invalid parameter');
    });

    it('should return friendly message for payload_too_large', () => {
      const message = getUserFriendlyErrorMessage('413 error', mockT);
      expect(message).toBe('Payload too large');
    });

    it('should return friendly message for network_error', () => {
      const message = getUserFriendlyErrorMessage('network failed', mockT);
      expect(message).toBe('Network error');
    });

    it('should return friendly message for timeout_error', () => {
      const message = getUserFriendlyErrorMessage('timeout', mockT);
      expect(message).toBe('Timeout error');
    });

    it('should return friendly message for generic_error', () => {
      const message = getUserFriendlyErrorMessage('unknown error', mockT);
      expect(message).toBe('Generic error');
    });

    it('should handle Error objects', () => {
      const error = new Error('network error');
      const message = getUserFriendlyErrorMessage(error, mockT);
      expect(message).toBe('Network error');
    });
  });
});
