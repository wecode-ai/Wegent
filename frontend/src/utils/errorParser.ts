// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse error messages and return user-friendly error information
 */

export interface ParsedError {
  type: 'payload_too_large' | 'network_error' | 'timeout_error' | 'generic_error';
  message: string;
  originalError?: string;
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

  // Check for 413 Payload Too Large error
  if (lowerMessage.includes('413') || lowerMessage.includes('payload too large')) {
    return {
      type: 'payload_too_large',
      message: errorMessage,
      originalError: errorMessage,
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
    };
  }

  // Check for timeout errors
  if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
    return {
      type: 'timeout_error',
      message: errorMessage,
      originalError: errorMessage,
    };
  }

  // Generic error
  return {
    type: 'generic_error',
    message: errorMessage,
    originalError: errorMessage,
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
    case 'payload_too_large':
      return t('chat:errors.payload_too_large');
    case 'network_error':
      return t('chat:errors.network_error');
    case 'timeout_error':
      return t('chat:errors.timeout_error');
    default:
      return parsed.message;
  }
}
