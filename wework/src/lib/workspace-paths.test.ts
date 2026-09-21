import { describe, expect, test, vi } from 'vitest'
import {
  isAbsoluteWorkspacePath,
  isWindowsDriveAbsolutePath,
  resolveHomeRelativeWorkspacePath,
} from './workspace-paths'

describe('resolveHomeRelativeWorkspacePath', () => {
  test.each(['/Users/me/', 'C:\\Users\\me\\'])(
    'resolves paths against the addressed device home: %s',
    async home => {
      const getHome = vi.fn().mockResolvedValue(home)
      expect(
        await resolveHomeRelativeWorkspacePath(
          '~/.agents/skills/test-skill/SKILL.md',
          'device-1',
          getHome
        )
      ).toBe(`${home.replace(/\\/g, '/').replace(/\/+$/, '')}/.agents/skills/test-skill/SKILL.md`)
      expect(getHome).toHaveBeenCalledWith('device-1')
    }
  )

  test.each(['/workspace/file.md', 'src/file.ts', '~other/file.md'])(
    'preserves other paths without querying a home: %s',
    async path => {
      const getHome = vi.fn()
      expect(await resolveHomeRelativeWorkspacePath(path, 'device-1', getHome)).toBe(path)
      expect(getHome).not.toHaveBeenCalled()
    }
  )

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
  test('recognizes forward- and backslash Windows drive-letter paths', () => {
    expect(isWindowsDriveAbsolutePath('C:/projects/example-app')).toBe(true)
    expect(isWindowsDriveAbsolutePath('C:\\projects\\example-app')).toBe(true)
    expect(isWindowsDriveAbsolutePath('c:/repo')).toBe(true)
  })

  test('rejects drive-relative and non-drive values', () => {
    expect(isWindowsDriveAbsolutePath('D:relative')).toBe(false)
    expect(isWindowsDriveAbsolutePath('/Users/me/repo')).toBe(false)
    expect(isWindowsDriveAbsolutePath('https://example.com')).toBe(false)
  })
})

describe('isAbsoluteWorkspacePath', () => {
  test('accepts POSIX and Windows drive-letter absolute paths', () => {
    expect(isAbsoluteWorkspacePath('/Users/me/repo')).toBe(true)
    expect(isAbsoluteWorkspacePath('C:/projects/example-app')).toBe(true)
  })

  test('rejects relative paths', () => {
    expect(isAbsoluteWorkspacePath('repo/file.ts')).toBe(false)
    expect(isAbsoluteWorkspacePath('./repo/file.ts')).toBe(false)
  })
})
