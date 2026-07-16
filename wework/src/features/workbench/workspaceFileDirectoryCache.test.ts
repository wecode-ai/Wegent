import { describe, expect, test } from 'vitest'
import {
  isWorkspaceDirectoryCacheFresh,
  WORKSPACE_DIRECTORY_CACHE_TTL_MS,
} from './workspaceFileDirectoryCache'

describe('isWorkspaceDirectoryCacheFresh', () => {
  test('uses cached directories only within the configured TTL', () => {
    const loadedAt = 1_000

    expect(isWorkspaceDirectoryCacheFresh(loadedAt, loadedAt + 1)).toBe(true)
    expect(
      isWorkspaceDirectoryCacheFresh(loadedAt, loadedAt + WORKSPACE_DIRECTORY_CACHE_TTL_MS - 1)
    ).toBe(true)
    expect(
      isWorkspaceDirectoryCacheFresh(loadedAt, loadedAt + WORKSPACE_DIRECTORY_CACHE_TTL_MS)
    ).toBe(false)
  })

  test('does not treat a missing timestamp as cached', () => {
    expect(isWorkspaceDirectoryCacheFresh(undefined, 1_000)).toBe(false)
  })
})
