import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import { useWorkspaceMentionSearch } from '@wegent/collaboration/composer/useWorkspaceMentionSearch'

describe('useWorkspaceMentionSearch', () => {
  const target = { deviceId: 'device', path: '/workspace' }
  afterEach(() => {
    vi.useRealTimers()
  })

  test('stays idle for empty queries and hosts without file search', () => {
    const searchWorkspaceEntries = vi.fn()
    const empty = renderHook(() =>
      useWorkspaceMentionSearch('', target, { searchWorkspaceEntries })
    )
    const unsupported = renderHook(() => useWorkspaceMentionSearch('README', target))
    expect(empty.result.current).toMatchObject({ loading: false, error: false, matches: [] })
    expect(unsupported.result.current).toMatchObject({ loading: false, error: false, matches: [] })
    expect(searchWorkspaceEntries).not.toHaveBeenCalled()
  })

  test('retries a failed search without editing the query and clears the error', async () => {
    vi.useFakeTimers()
    const file = {
      root: '/workspace',
      path: 'README.md',
      fileName: 'README.md',
      matchType: 'file' as const,
      score: 1,
    }
    const searchWorkspaceEntries = vi
      .fn()
      .mockRejectedValueOnce(new Error('Device offline'))
      .mockResolvedValueOnce({ files: [file] })
    const { result } = renderHook(() =>
      useWorkspaceMentionSearch('README', target, { searchWorkspaceEntries })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80)
    })
    expect(result.current).toMatchObject({ error: true, loading: false, matches: [] })
    act(() => result.current.retry())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80)
    })
    expect(searchWorkspaceEntries).toHaveBeenCalledTimes(2)
    expect(result.current).toMatchObject({ error: false, loading: false, matches: [file] })
  })

  test('ignores a stale search response after switching workspace and query', async () => {
    vi.useFakeTimers()
    let finishOld!: (response: { files: [] }) => void
    const searchWorkspaceEntries = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishOld = resolve
          })
      )
      .mockResolvedValueOnce({
        files: [
          { root: '/other', path: 'new.ts', fileName: 'new.ts', matchType: 'file', score: 1 },
        ],
      })
    const { result, rerender } = renderHook(
      ({ path, query }) =>
        useWorkspaceMentionSearch(query, { ...target, path }, { searchWorkspaceEntries }),
      { initialProps: { path: '/workspace', query: 'old' } }
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80)
    })
    rerender({ path: '/other', query: 'new' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80)
    })
    await act(async () => finishOld({ files: [] }))
    expect(result.current.matches.map(item => item.path)).toEqual(['new.ts'])
    expect(result.current.loading).toBe(false)
  })

  test('keeps the debounce when the workspace target remains logically equivalent', async () => {
    vi.useFakeTimers()
    const searchWorkspaceEntries = vi.fn().mockResolvedValue({ files: [] })
    const workspaceFileApi = {
      listWorkspaceEntries: vi.fn(),
      searchWorkspaceEntries,
      readWorkspaceTextFile: vi.fn(),
    } satisfies WorkspaceFileApi
    const initialTarget: WorkspaceTarget = {
      deviceId: 'cloud-device',
      path: '/workspace/project',
      source: 'project',
    }
    const { rerender } = renderHook(
      ({ target }) => useWorkspaceMentionSearch('cloud-context-folder', target, workspaceFileApi),
      { initialProps: { target: initialTarget } }
    )

    act(() => {
      vi.advanceTimersByTime(40)
    })
    rerender({
      target: {
        ...initialTarget,
      },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40)
    })

    expect(searchWorkspaceEntries).toHaveBeenCalledWith(
      'cloud-device',
      '/workspace/project',
      'cloud-context-folder',
      expect.any(String)
    )
  })
})
