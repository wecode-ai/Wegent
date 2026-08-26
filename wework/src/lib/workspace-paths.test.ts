import { describe, expect, test } from 'vitest'
import { isAbsoluteWorkspacePath, isWindowsDriveAbsolutePath } from './workspace-paths'

describe('isWindowsDriveAbsolutePath', () => {
  test('recognizes forward- and backslash Windows drive-letter paths', () => {
    expect(isWindowsDriveAbsolutePath('D:/jiaqi62/Projects/wegent')).toBe(true)
    expect(isWindowsDriveAbsolutePath('D:\\jiaqi62\\Projects\\wegent')).toBe(true)
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
    expect(isAbsoluteWorkspacePath('D:/jiaqi62/Projects/wegent')).toBe(true)
  })

  test('rejects relative paths', () => {
    expect(isAbsoluteWorkspacePath('repo/file.ts')).toBe(false)
    expect(isAbsoluteWorkspacePath('./repo/file.ts')).toBe(false)
  })
})
