// @vitest-environment node

import { describe, expect, test } from 'vitest'
import {
  isAbsoluteWorkspacePath,
  normalizeAbsoluteWorkspacePath,
  normalizeWorkspaceTree,
  splitAbsoluteWorkspaceFilePath,
} from './workspace-file-contract'

describe('workspace file contract', () => {
  test('normalizes Windows drive paths and canonical verbatim paths', () => {
    expect(normalizeAbsoluteWorkspacePath(String.raw`c:\work\Wegent`, 'invalid')).toBe(
      'C:/work/Wegent'
    )
    expect(normalizeAbsoluteWorkspacePath(String.raw`\\?\C:\work\Wegent\src`, 'invalid')).toBe(
      'C:/work/Wegent/src'
    )
    expect(isAbsoluteWorkspacePath(String.raw`C:\work\Wegent`)).toBe(true)
    expect(isAbsoluteWorkspacePath('C:work/Wegent')).toBe(false)
  })

  test('normalizes Windows UNC and canonical UNC paths', () => {
    expect(normalizeAbsoluteWorkspacePath(String.raw`\\server\share\Wegent`, 'invalid')).toBe(
      '//server/share/Wegent'
    )
    expect(normalizeAbsoluteWorkspacePath(String.raw`\\?\UNC\server\share\Wegent`, 'invalid')).toBe(
      '//server/share/Wegent'
    )
  })

  test('maps canonical Windows workspace tree paths back to the requested root', () => {
    expect(
      normalizeWorkspaceTree(
        {
          path: String.raw`\\?\C:\work\Wegent`,
          entries: [
            {
              name: 'src',
              path: String.raw`\\?\C:\work\Wegent\src`,
              is_directory: true,
              size: 0,
              modified_at: null,
            },
          ],
        },
        String.raw`c:\work\Wegent`
      )
    ).toEqual({
      path: String.raw`C:\work\Wegent`,
      entries: [
        {
          name: 'src',
          path: String.raw`C:\work\Wegent\src`,
          isDirectory: true,
          size: 0,
          modifiedAt: null,
        },
      ],
    })
  })

  test('matches Windows workspace directory names case-insensitively', () => {
    expect(
      normalizeWorkspaceTree(
        {
          path: String.raw`\\?\C:\WORK\WEGENT`,
          entries: [
            {
              name: 'src',
              path: String.raw`\\?\C:\WORK\WEGENT\src`,
              is_directory: true,
              size: 0,
              modified_at: null,
            },
          ],
        },
        String.raw`c:\work\Wegent`
      )
    ).toEqual({
      path: String.raw`C:\work\Wegent`,
      entries: [
        {
          name: 'src',
          path: String.raw`C:\work\Wegent\src`,
          isDirectory: true,
          size: 0,
          modifiedAt: null,
        },
      ],
    })
  })

  test('matches POSIX workspace directory names case-sensitively', () => {
    expect(() =>
      normalizeWorkspaceTree(
        {
          path: '/work/wegent',
          entries: [],
        },
        '/work/Wegent'
      )
    ).toThrow('Invalid workspace tree response')
  })

  test('splits files directly beneath a Windows drive root', () => {
    expect(splitAbsoluteWorkspaceFilePath(String.raw`C:\README.md`)).toEqual({
      parentPath: 'C:/',
      fileName: 'README.md',
    })
  })

  test('rejects traversal above Windows and POSIX roots', () => {
    expect(() => normalizeAbsoluteWorkspacePath('C:/../secret', 'invalid')).toThrow('invalid')
    expect(() => normalizeAbsoluteWorkspacePath('/../secret', 'invalid')).toThrow('invalid')
  })
})

describe('normalizeAbsoluteWorkspacePath', () => {
  test('rejects relative and drive-relative paths', () => {
    expect(() => normalizeAbsoluteWorkspacePath('repo/file.ts', 'x')).toThrow('x')
    expect(() => normalizeAbsoluteWorkspacePath('./repo/file.ts', 'x')).toThrow('x')
    expect(() => normalizeAbsoluteWorkspacePath('D:relative', 'x')).toThrow('x')
  })
})
