// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

export function requestFailureMessage(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  return message && message !== 'Failed to fetch' ? message : fallback
}
