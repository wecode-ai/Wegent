import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import { useWorkspaceMentionSearch } from './useWorkspaceMentionSearch'

describe('useWorkspaceMentionSearch', () => {
  afterEach(() => {
    vi.useRealTimers()
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
