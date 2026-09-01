import { describe, expect, test } from 'vitest'
import {
  basename,
  getParentPath,
  getPathSearchParts,
  joinPath,
  normalizePath,
} from './device-folder-path'

describe('device folder paths', () => {
  test('preserves Windows drive roots and separators', () => {
    expect(normalizePath('D:\\')).toBe('D:\\')
    expect(joinPath('D:\\a\\Wegent', 'workspace')).toBe('D:\\a\\Wegent\\workspace')
    expect(basename('D:\\a\\Wegent\\workspace')).toBe('workspace')
    expect(getParentPath('D:\\a\\Wegent\\workspace')).toBe('D:\\a\\Wegent')
    expect(getParentPath('D:\\workspace')).toBe('D:\\')
  })

  test('splits a Windows path into its parent and search query', () => {
    expect(getPathSearchParts('D:\\a\\Wegent\\workspace')).toEqual({
      parentPath: 'D:\\a\\Wegent',
      query: 'workspace',
    })
  })
})
