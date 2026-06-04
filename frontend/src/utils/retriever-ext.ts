// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type RetrieverStorageExt = Record<string, unknown>

export function formatRetrieverStorageExt(ext?: RetrieverStorageExt): string {
  if (!ext || Object.keys(ext).length === 0) {
    return ''
  }

  return JSON.stringify(ext, null, 2)
}

export function parseRetrieverStorageExt(raw: string): RetrieverStorageExt | undefined {
  const trimmed = raw.trim()
  if (!trimmed) {
    return undefined
  }

  const parsed: unknown = JSON.parse(trimmed)

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Retriever storage extension JSON must be an object')
  }

  return parsed as RetrieverStorageExt
}
