// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  removeTaskQueryParams,
  removeTeamQueryParam,
} from '@/features/tasks/utils/task-query-params'

describe('task query params', () => {
  it('removes teamId while preserving other query parameters', () => {
    const params = new URLSearchParams('teamId=42&agent=code')

    expect(removeTeamQueryParam(params)).toBe(true)
    expect(params.toString()).toBe('agent=code')
  })

  it('reports when no teamId was removed', () => {
    expect(removeTeamQueryParam(new URLSearchParams('agent=code'))).toBe(false)
  })

  it('removes all supported task ID aliases', () => {
    const params = new URLSearchParams('taskId=1&task_id=2&taskid=3&teamId=42')

    expect(removeTaskQueryParams(params)).toBe(true)
    expect(params.toString()).toBe('teamId=42')
  })
})
