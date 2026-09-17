// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'

import { modelApis, type UnifiedModelListResponse } from '@/apis/models'
import { useShellModels } from '@/features/settings/hooks/useShellModels'

jest.mock('@/apis/models', () => ({ modelApis: { getUnifiedModels: jest.fn() } }))

const getModels = jest.mocked(modelApis.getUnifiedModels)
const claudeModels: UnifiedModelListResponse = {
  data: [{ name: 'model-a', type: 'public', namespace: 'default' }],
}

describe('useShellModels', () => {
  beforeEach(() => jest.resetAllMocks())

  it('uses the custom shell name and preserves scope and category filters', async () => {
    getModels.mockResolvedValue(claudeModels)
    const onError = jest.fn()
    const { result } = renderHook(() =>
      useShellModels({
        enabled: true,
        shellName: 'shell-a',
        scope: 'group',
        groupName: 'group-a',
        category: 'llm',
        onError,
      })
    )

    await waitFor(() => expect(result.current.hasLoaded).toBe(true))
    expect(getModels).toHaveBeenCalledWith('shell-a', false, 'group', 'group-a', 'llm')
    expect(result.current.models).toEqual(claudeModels.data)
  })

  it('hides stale choices while switching engines and ignores late responses', async () => {
    let resolveCodex!: (response: UnifiedModelListResponse) => void
    getModels.mockImplementation(shellName =>
      shellName === 'Codex'
        ? new Promise(resolve => {
            resolveCodex = resolve
          })
        : Promise.resolve(claudeModels)
    )
    const onError = jest.fn()
    const { result, rerender } = renderHook(
      ({ shellName }) =>
        useShellModels({
          enabled: true,
          shellName,
          category: 'llm',
          onError,
        }),
      { initialProps: { shellName: 'Codex' } }
    )

    rerender({ shellName: 'ClaudeCode' })
    expect(result.current.isLoading).toBe(true)
    expect(result.current.hasLoaded).toBe(false)
    expect(result.current.models).toEqual([])
    await waitFor(() => expect(result.current.hasLoaded).toBe(true))
    expect(result.current.shellChanged).toBe(true)

    await act(async () => resolveCodex({ data: [{ name: 'model-b', type: 'public' }] }))
    expect(result.current.models).toEqual(claudeModels.data)
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not accept a failed model lookup as a validated empty list', async () => {
    const onError = jest.fn()
    getModels.mockRejectedValue(new Error('Unavailable'))
    const { result } = renderHook(() =>
      useShellModels({
        enabled: true,
        shellName: 'ClaudeCode',
        category: 'llm',
        onError,
      })
    )

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.hasLoaded).toBe(false)
    expect(result.current.models).toEqual([])
  })
})
