import { describe, expect, test } from 'vitest'
import { workspaceRelativePath } from './workspace-relative-path'

describe('workspaceRelativePath', () => {
  test('returns the path relative to the workspace root', () => {
    expect(workspaceRelativePath('/workspace/project', '/workspace/project/src/index.ts')).toBe(
      'src/index.ts'
    )
    expect(workspaceRelativePath('/workspace/project', '/workspace/project/README.md')).toBe(
      'README.md'
    )
  })

  test('returns an empty string for the root itself', () => {
    expect(workspaceRelativePath('/workspace/project', '/workspace/project')).toBe('')
    expect(workspaceRelativePath('/workspace/project', '/workspace/project/')).toBe('')
  })

  test('normalizes trailing separators and backslashes', () => {
    expect(workspaceRelativePath('/workspace/project/', '/workspace/project\\src\\index.ts')).toBe(
      'src/index.ts'
    )
    expect(workspaceRelativePath('/workspace/project', '/workspace/project/src/')).toBe('src')
  })

  test('strips leading separators from paths outside the root', () => {
    expect(workspaceRelativePath('/workspace/project', '/other/path/file.ts')).toBe(
      'other/path/file.ts'
    )
  })
})
