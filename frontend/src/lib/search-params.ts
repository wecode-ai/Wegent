// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

type SearchParamsLike = Pick<URLSearchParams, 'get' | 'toString'>

export function getSearchParam(
  searchParams: SearchParamsLike | null | undefined,
  key: string
): string | null {
  return searchParams?.get(key) ?? null
}

export function getFirstSearchParam(
  searchParams: SearchParamsLike | null | undefined,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = getSearchParam(searchParams, key)
    if (value !== null) return value
  }

  return null
}

export function stringifySearchParams(searchParams: SearchParamsLike | null | undefined): string {
  return searchParams?.toString() ?? ''
}
