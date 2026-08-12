// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  removeGenerationModeQueryParam,
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

  it('removes image and video generation modes while preserving other query parameters', () => {
    const imageParams = new URLSearchParams('teamId=42&mode=image&projectId=7')
    const videoParams = new URLSearchParams('teamId=43&mode=video')

    expect(removeGenerationModeQueryParam(imageParams)).toBe(true)
    expect(imageParams.toString()).toBe('teamId=42&projectId=7')
    expect(removeGenerationModeQueryParam(videoParams)).toBe(true)
    expect(videoParams.toString()).toBe('teamId=43')
  })

  it('does not remove unrelated modes', () => {
    const params = new URLSearchParams('mode=code')

    expect(removeGenerationModeQueryParam(params)).toBe(false)
    expect(params.toString()).toBe('mode=code')
  })

  it('removes all supported task ID aliases', () => {
    const params = new URLSearchParams('taskId=1&task_id=2&taskid=3&teamId=42')

    expect(removeTaskQueryParams(params)).toBe(true)
    expect(params.toString()).toBe('teamId=42')
  })
})
