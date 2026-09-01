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

describe('normalizeAbsoluteWorkspacePath', () => {
  test('accepts POSIX absolute paths', () => {
    expect(normalizeAbsoluteWorkspacePath('/a/b/../c.ts', 'x')).toBe('/a/c.ts')
    expect(normalizeAbsoluteWorkspacePath('/a//b/c.ts', 'x')).toBe('/a/b/c.ts')
    expect(normalizeAbsoluteWorkspacePath('/', 'x')).toBe('/')
  })

  test('accepts Windows drive-letter absolute paths', () => {
    expect(normalizeAbsoluteWorkspacePath('D:/jiaqi62/Wegent/README.md', 'x')).toBe(
      'D:/jiaqi62/Wegent/README.md'
    )
    expect(normalizeAbsoluteWorkspacePath('D:\\jiaqi62\\Wegent\\README.md', 'x')).toBe(
      'D:/jiaqi62/Wegent/README.md'
    )
    expect(normalizeAbsoluteWorkspacePath('d:/foo', 'x')).toBe('D:/foo')
    expect(normalizeAbsoluteWorkspacePath('C:/', 'x')).toBe('C:/')
  })

  test('rejects relative and drive-relative paths', () => {
    expect(() => normalizeAbsoluteWorkspacePath('repo/file.ts', 'x')).toThrow('x')
    expect(() => normalizeAbsoluteWorkspacePath('./repo/file.ts', 'x')).toThrow('x')
    expect(() => normalizeAbsoluteWorkspacePath('D:relative', 'x')).toThrow('x')
  })
})

describe('splitAbsoluteWorkspaceFilePath', () => {
  test('splits POSIX paths', () => {
    expect(splitAbsoluteWorkspaceFilePath('/a/b/file.ts')).toEqual({
      parentPath: '/a/b',
      fileName: 'file.ts',
    })
  })

  test('splits Windows drive-letter paths', () => {
    expect(splitAbsoluteWorkspaceFilePath('D:/jiaqi62/Wegent/README.md')).toEqual({
      parentPath: 'D:/jiaqi62/Wegent',
      fileName: 'README.md',
    })
    expect(splitAbsoluteWorkspaceFilePath('D:\\jiaqi62\\Wegent\\AGENTS.md')).toEqual({
      parentPath: 'D:/jiaqi62/Wegent',
      fileName: 'AGENTS.md',
    })
    expect(splitAbsoluteWorkspaceFilePath('D:/README.md')).toEqual({
      parentPath: 'D:/',
      fileName: 'README.md',
    })
  })
})

describe('normalizeWorkspaceTree', () => {
  test('normalizes Windows drive-letter tree responses with backslash paths', () => {
    const result = normalizeWorkspaceTree(
      {
        path: 'D:\\jiaqi62\\Wegent',
        entries: [
          {
            name: 'README.md',
            path: 'D:\\jiaqi62\\Wegent\\README.md',
            is_directory: false,
            size: 10,
            modified_at: null,
          },
        ],
      },
      'D:/jiaqi62/Wegent'
    )

    expect(result.path).toBe('D:/jiaqi62/Wegent')
    expect(result.entries).toEqual([
      expect.objectContaining({
        path: 'D:/jiaqi62/Wegent/README.md',
        isDirectory: false,
      }),
    ])
  })
})

describe('normalizeWorkspaceTextFile', () => {
  test('normalizes Windows drive-letter text file responses', () => {
    const result = normalizeWorkspaceTextFile(
      {
        path: 'D:\\jiaqi62\\Wegent\\README.md',
        name: 'README.md',
        content: 'hello',
        editable: true,
        revision: 'sha256:r1',
        truncated: false,
        size: 5,
        modified_at: null,
      },
      'D:/jiaqi62/Wegent/README.md'
    )

    expect(result.path).toBe('D:/jiaqi62/Wegent/README.md')
    expect(result.name).toBe('README.md')
    expect(result.content).toBe('hello')
  })
})
