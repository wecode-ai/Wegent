// @vitest-environment node

import { describe, expect, test, vi } from 'vitest'
import {
  isAbsoluteWorkspacePath,
  isWindowsDriveAbsolutePath,
  resolveHomeRelativeWorkspacePath,
} from './workspace-paths'

describe('resolveHomeRelativeWorkspacePath', () => {
  test('propagates home lookup failures and rejects invalid homes', async () => {
    const getHome = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('')
    await expect(
      resolveHomeRelativeWorkspacePath('~/file.md', 'device-1', getHome)
    ).rejects.toThrow('offline')
    await expect(
      resolveHomeRelativeWorkspacePath('~/file.md', 'device-1', getHome)
    ).rejects.toThrow('Invalid device home directory')
  })
})

describe('isWindowsDriveAbsolutePath', () => {
  test('rejects drive-relative and non-drive values', () => {
    expect(isWindowsDriveAbsolutePath('D:relative')).toBe(false)
    expect(isWindowsDriveAbsolutePath('/Users/me/repo')).toBe(false)
    expect(isWindowsDriveAbsolutePath('https://example.com')).toBe(false)
  })
})

describe('isAbsoluteWorkspacePath', () => {
  test('rejects relative paths', () => {
    expect(isAbsoluteWorkspacePath('repo/file.ts')).toBe(false)
    expect(isAbsoluteWorkspacePath('./repo/file.ts')).toBe(false)
  })
})
