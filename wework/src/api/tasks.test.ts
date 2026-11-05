// @vitest-environment node

import { describe, expect, test, vi } from 'vitest'
import type { HttpClient } from './http'
import { createTaskApi } from './tasks'

describe('createTaskApi', () => {
  test('reverts turn file changes by subtask id', async () => {
    const client = {
      post: vi.fn().mockResolvedValue({ file_changes: [] }),
    } as unknown as HttpClient

    await createTaskApi(client).revertTurnFileChanges(42)

    expect(client.post).toHaveBeenCalledWith('/subtasks/42/file-changes/revert')
  })
})
