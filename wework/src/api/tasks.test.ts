import { describe, expect, test, vi } from 'vitest'
import { createTaskApi } from './tasks'
import type { HttpClient } from './http'

describe('createTaskApi', () => {
  test('loads turn file changes diff by subtask id', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({ diff: 'diff --git a/file b/file' }),
    } as unknown as HttpClient

    await createTaskApi(client).getTurnFileChangesDiff(42)

    expect(client.get).toHaveBeenCalledWith('/subtasks/42/file-changes/diff')
  })

  test('reverts turn file changes by subtask id', async () => {
    const client = {
      post: vi.fn().mockResolvedValue({ file_changes: [] }),
    } as unknown as HttpClient

    await createTaskApi(client).revertTurnFileChanges(42)

    expect(client.post).toHaveBeenCalledWith('/subtasks/42/file-changes/revert')
  })
})
