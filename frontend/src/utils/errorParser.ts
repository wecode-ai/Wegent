// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse error messages and return user-friendly error information
 */

export interface ParsedError {
  type:
    | 'payload_too_large'
    | 'network_error'
    | 'timeout_error'
    | 'llm_error'
    | 'llm_unsupported'
    | 'invalid_parameter'
    | 'forbidden'
    | 'generic_error';
  message: string;
  originalError?: string;
  retryable?: boolean;
}

/**
 * Parse error and return structured error information
 *
 * @param error - Error object or error message
 * @returns Parsed error information
 */
export function parseError(error: Error | string): ParsedError {
  const errorMessage = typeof error === 'string' ? error : error.message;
  const lowerMessage = errorMessage.toLowerCase();

  // Check for forbidden/unauthorized errors
  if (
    lowerMessage.includes('forbidden') ||
    lowerMessage.includes('not allowed') ||
    lowerMessage.includes('unauthorized') ||
    lowerMessage.includes('403')
  ) {
    return {
      type: 'forbidden',
      message: errorMessage,
      originalError: errorMessage,
      retryable: false, // Permission errors are not retryable
    };
  }

  // Check for model unsupported errors (multi-modal, model incompatibility)
  // These errors indicate the model doesn't support the request format
  if (
    lowerMessage.includes('multi-modal') ||
    lowerMessage.includes('multimodal') ||
    (lowerMessage.includes('llm model') && lowerMessage.includes('received'))
  ) {
    return {
      type: 'llm_unsupported',
      message: errorMessage,
      originalError: errorMessage,
      retryable: false, // User should switch model, not retry
    };
  }

  // Check for general LLM errors (model unavailable, not found, etc.)
  // These are temporary issues that can be retried
  if (
    lowerMessage.includes('model not found') ||
    lowerMessage.includes('model unavailable') ||
    lowerMessage.includes('llm')
  ) {
    return {
      type: 'llm_error',
      message: errorMessage,
      originalError: errorMessage,
      retryable: true,
    };
  }

  // Check for invalid parameter errors (generic)
  if (lowerMessage.includes('invalid') && lowerMessage.includes('parameter')) {
    return {
      type: 'invalid_parameter',
      message: errorMessage,
      originalError: errorMessage,
      retryable: true, // Allow retry for generic parameter errors
    };
  }

  // Check for 413 Payload Too Large error
  if (lowerMessage.includes('413') || lowerMessage.includes('payload too large')) {
    return {
      type: 'payload_too_large',
      message: errorMessage,
      originalError: errorMessage,
      retryable: true, // Allow retry even for large payloads (user might reduce content)
    };
  }

  // Check for network errors
  if (
    lowerMessage.includes('network') ||
    lowerMessage.includes('fetch') ||
    lowerMessage.includes('connection')
  ) {
    return {
      type: 'network_error',
      message: errorMessage,
      originalError: errorMessage,
      retryable: true,
    };
  }

  // Check for timeout errors
  if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
    return {
      type: 'timeout_error',
      message: errorMessage,
      originalError: errorMessage,
      retryable: true,
    };
  }

  // Generic error
  return {
    type: 'generic_error',
    message: errorMessage,
    originalError: errorMessage,
    retryable: true,
  };
}

/**
 * Get user-friendly error message with i18n support
 *
 * @param error - Error object or error message
 * @param t - i18n translation function
 * @returns User-friendly error message
 */
export function getUserFriendlyErrorMessage(
  error: Error | string,
  t: (key: string) => string
): string {
  const parsed = parseError(error);

  switch (parsed.type) {
    case 'forbidden':
      // Use dedicated translation key for forbidden errors, fallback to generic if not available
      return t('errors.forbidden') || t('errors.generic_error');
    case 'llm_unsupported':
      return t('errors.llm_unsupported');
    case 'llm_error':
      return t('errors.llm_error');
    case 'invalid_parameter':
      return t('errors.invalid_parameter');
    case 'payload_too_large':
      return t('errors.payload_too_large');
    case 'network_error':
      return t('errors.network_error');
    case 'timeout_error':
      return t('errors.timeout_error');
    default:
      return t('errors.generic_error');
  }
}
