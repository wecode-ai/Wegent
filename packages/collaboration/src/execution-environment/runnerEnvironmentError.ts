// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationTranslate } from '../i18n'

/** Translate the routing denial without treating it as an authentication error. */
export function runnerEnvironmentError(
  error: unknown,
  translate: CollaborationTranslate
): string | null {
  if (!error || typeof error !== 'object') return null
  const value = error as {
    errorCode?: string
    error_code?: string
    detail?: { error_code?: string }
  }
  const code = value.errorCode ?? value.error_code ?? value.detail?.error_code
  return code === 'RUNNER_ENVIRONMENT_UNAVAILABLE'
    ? translate('todo.runner_environment_not_authorized')
    : null
}
