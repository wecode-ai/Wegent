import { waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { WorkspaceTreeResponse } from '@/types/workspace-files'
import { createWorkspaceDirectoryState } from './workspaceDirectoryState'

const initial = {
  selectedPath: '/fixture/repo/src/api/a.py',
  visible: false,
  refreshVersion: 0,
}

test('loads ancestors on reveal and resumes after an explicit retry', async () => {
  const loadDirectory = vi
    .fn(async (path: string) => ({ path, entries: [] }))
    .mockRejectedValueOnce(new Error('Directory unavailable'))
  const source = createWorkspaceDirectoryState('/fixture/repo', loadDirectory, false)
  const stop = source.subscribe(() => {}, initial)
  try {
    expect(loadDirectory).not.toHaveBeenCalled()
    source.updateReveal({ ...initial, visible: true })
    await waitFor(() => {
      expect(loadDirectory).toHaveBeenCalledTimes(1)
      expect(source.getSnapshot().loadingPaths.size).toBe(0)
      expect(source.getSnapshot().error).toBe('Directory unavailable')
    })
    expect(loadDirectory).toHaveBeenCalledWith('/fixture/repo/src')
    source.updateReveal({ ...initial, visible: true, refreshVersion: 1 })
    await waitFor(() => expect(loadDirectory).toHaveBeenCalledTimes(3))
    expect(loadDirectory).toHaveBeenLastCalledWith('/fixture/repo/src/api')
  } finally {
    stop()
  }
})

test('does not continue revealing an old file after a switch', async () => {
  let resolve!: (response: WorkspaceTreeResponse) => void
  const loadDirectory = vi
    .fn<(path: string) => Promise<WorkspaceTreeResponse>>()
    .mockImplementationOnce(
      () =>
        new Promise<WorkspaceTreeResponse>(done => {
          resolve = done
        })
    )
    .mockImplementation(async path => ({ path, entries: [] }))
  const source = createWorkspaceDirectoryState('/fixture/repo', loadDirectory, false)
  const stop = source.subscribe(() => {}, { ...initial, visible: true })
  try {
    source.updateReveal({ ...initial, visible: true, selectedPath: '/fixture/repo/docs/readme.md' })
    resolve({ path: '/fixture/repo/src', entries: [] })
    await waitFor(() => expect(source.getSnapshot().loadingPaths.size).toBe(0))
    expect(loadDirectory.mock.calls.map(([path]) => path)).toEqual([
      '/fixture/repo/src',
      '/fixture/repo/docs',
    ])
  } finally {
    stop()
  }
})
