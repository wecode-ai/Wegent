// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

export function hasVersionConflictCode(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const source = error as Record<string, unknown>
  const detail =
    source.detail && typeof source.detail === 'object'
      ? (source.detail as Record<string, unknown>)
      : {}
  return (
    (detail.reason_code ?? detail.code ?? source.errorCode ?? source.code) === 'version_conflict'
  )
}
