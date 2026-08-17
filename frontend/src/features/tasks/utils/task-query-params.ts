// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

type SearchParamsReader = Pick<URLSearchParams, 'get'>

export const TASK_QUERY_KEYS = ['taskId', 'task_id', 'taskid'] as const
export const TEAM_QUERY_KEY = 'teamId'
export const GENERATION_MODE_QUERY_KEY = 'mode'

export function getTaskQueryParam(searchParams: SearchParamsReader): string | null {
  for (const key of TASK_QUERY_KEYS) {
    const value = searchParams.get(key)
    if (value) return value
  }
  return null
}

export function removeTaskQueryParams(searchParams: URLSearchParams): boolean {
  let removed = false
  for (const key of TASK_QUERY_KEYS) {
    if (searchParams.has(key)) {
      searchParams.delete(key)
      removed = true
    }
  }
  return removed
}

export function removeTeamQueryParam(searchParams: URLSearchParams): boolean {
  if (!searchParams.has(TEAM_QUERY_KEY)) return false
  searchParams.delete(TEAM_QUERY_KEY)
  return true
}

export function removeGenerationModeQueryParam(searchParams: URLSearchParams): boolean {
  const mode = searchParams.get(GENERATION_MODE_QUERY_KEY)
  if (mode !== 'image' && mode !== 'video') return false
  searchParams.delete(GENERATION_MODE_QUERY_KEY)
  return true
}
