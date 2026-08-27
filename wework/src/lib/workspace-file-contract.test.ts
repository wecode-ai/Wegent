import { describe, expect, test } from 'vitest'
import {
  normalizeAbsoluteWorkspacePath,
  normalizeWorkspaceTextFile,
  normalizeWorkspaceTree,
  splitAbsoluteWorkspaceFilePath,
} from './workspace-file-contract'

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
    expect(normalizeAbsoluteWorkspacePath('d:/foo', 'x')).toBe('d:/foo')
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
