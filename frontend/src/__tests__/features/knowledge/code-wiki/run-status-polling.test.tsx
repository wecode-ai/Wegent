// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'
import { codeWikiApi } from '@/apis/code-wiki'
import { useCodeWikiRunStatus } from '@/features/knowledge/code-wiki/useCodeWikiRunStatus'
import type { CodeWikiRunStatus } from '@/types/code-wiki'

jest.mock('@/apis/code-wiki', () => ({
  codeWikiApi: { status: jest.fn() },
}))

const status = (over: Partial<CodeWikiRunStatus>): CodeWikiRunStatus => ({
  status: 'completed',
  generation_id: 40,
  error_message: '',
  failure_code: '',
  is_stale: false,
  last_published_commit: '',
  ...over,
})

const progress = (stage: 'writing' | 'qa_review', step: number): CodeWikiRunStatus =>
  status({
    status: 'running',
    generation_id: 41,
    progress: {
      stage,
      current_step: step,
      total_steps: 4,
      pages_written: step === 2 ? 7 : 13,
      pages_total: 13,
    },
  })

const flushPromises = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('code wiki run status polling', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.mocked(codeWikiApi.status).mockReset()
  })

  afterEach(() => jest.useRealTimers())

  it('starts ten-second polling when refresh discovers a run after an idle status', async () => {
    jest
      .mocked(codeWikiApi.status)
      .mockResolvedValueOnce(status({ status: 'completed' }))
      .mockResolvedValueOnce(progress('writing', 2))
      .mockResolvedValueOnce(progress('qa_review', 3))
      .mockResolvedValueOnce(status({ status: 'completed', generation_id: 41 }))

    const { result } = renderHook(() => useCodeWikiRunStatus(9))
    await flushPromises()
    expect(result.current.status?.status).toBe('completed')

    act(() => result.current.refresh())
    await flushPromises()
    expect(result.current.status?.progress?.stage).toBe('writing')

    await act(async () => {
      jest.advanceTimersByTime(9_999)
      await Promise.resolve()
    })
    expect(result.current.status?.progress?.stage).toBe('writing')
    expect(codeWikiApi.status).toHaveBeenCalledTimes(2)

    await act(async () => {
      jest.advanceTimersByTime(1)
      await Promise.resolve()
    })
    expect(result.current.status?.progress?.stage).toBe('qa_review')

    await act(async () => {
      jest.advanceTimersByTime(10_000)
      await Promise.resolve()
    })
    expect(result.current.status?.status).toBe('completed')

    act(() => jest.advanceTimersByTime(20_000))
    expect(codeWikiApi.status).toHaveBeenCalledTimes(4)
  })

  it('keeps polling an observed run after a transient status request failure', async () => {
    jest
      .mocked(codeWikiApi.status)
      .mockResolvedValueOnce(progress('writing', 2))
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(status({ status: 'completed', generation_id: 41 }))

    const { result } = renderHook(() => useCodeWikiRunStatus(9))
    await flushPromises()

    await act(async () => {
      jest.advanceTimersByTime(10_000)
      await Promise.resolve()
    })
    expect(result.current.status?.progress?.stage).toBe('writing')

    await act(async () => {
      jest.advanceTimersByTime(10_000)
      await Promise.resolve()
    })
    expect(codeWikiApi.status).toHaveBeenCalledTimes(3)
    expect(result.current.status?.status).toBe('completed')
  })
})
