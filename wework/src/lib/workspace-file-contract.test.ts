import { describe, expect, test } from 'vitest'
import {
  isAbsoluteWorkspacePath,
  normalizeAbsoluteWorkspacePath,
  normalizeWorkspaceFileChunk,
  normalizeWorkspaceTextFile,
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

  test('normalizes Windows text and binary file responses', () => {
    const requestedPath = String.raw`C:\work\Wegent\README.md`

    expect(
      normalizeWorkspaceTextFile(
        {
          path: String.raw`\\?\C:\work\Wegent\README.md`,
          name: 'README.md',
          content: 'hello',
          editable: true,
          revision: 'sha256:abc',
          truncated: false,
          size: 5,
          modified_at: null,
        },
        requestedPath
      )
    ).toMatchObject({
      path: String.raw`C:\work\Wegent\README.md`,
      name: 'README.md',
      content: 'hello',
    })

    expect(
      normalizeWorkspaceFileChunk(
        {
          path: String.raw`\\?\C:\work\Wegent\README.md`,
          name: 'README.md',
          content_base64: 'aGVsbG8=',
          offset: 0,
          eof: true,
          size: 5,
          modified_at: null,
        },
        requestedPath,
        0
      )
    ).toMatchObject({
      path: String.raw`C:\work\Wegent\README.md`,
      name: 'README.md',
      offset: 0,
    })
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
