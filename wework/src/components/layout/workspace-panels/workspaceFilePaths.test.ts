import { expect, test } from 'vitest'
import { workspaceParentPath as sharedWorkspaceParentPath } from '@wegent/chat-core/workspace-file-paths'
import { workspaceParentPath } from './workspaceFilePaths'

test('desktop and mobile use the shared workspace parent contract', () => {
  expect(workspaceParentPath).toBe(sharedWorkspaceParentPath)
})

test.each([
  ['/repo/src', '/repo'],
  ['/repo/src/', '/repo'],
  ['/', '/'],
  ['/repo', '/'],
  ['/repo/dir\\name/file', '/repo/dir\\name'],
  ['C:\\repo\\src', 'C:/repo'],
  ['c:\\repo\\', 'C:/'],
  ['C:\\', 'C:/'],
  ['C:/', 'C:/'],
  ['C:/repo/./src/../file', 'C:/repo'],
  ['//server/share/repo/src', '//server/share/repo'],
  ['//server/share/repo', '//server/share'],
  ['//server/share/', '//server/share'],
  ['//server/share', '//server/share'],
  ['\\\\server\\share\\repo', '//server/share'],
  ['\\\\server\\share\\', '//server/share'],
  ['\\\\?\\UNC\\server\\share\\repo', '//server/share'],
  ['\\\\?\\C:\\repo\\src', 'C:/repo'],
])('keeps the parent of %s inside its filesystem root', (path, expected) => {
  expect(workspaceParentPath(path)).toBe(expected)
})

test.each(['relative/path', '//server', '//server/share/..', 'C:/..'])(
  'rejects invalid absolute workspace path %s',
  path => {
    expect(() => workspaceParentPath(path)).toThrow('Workspace path must be absolute')
  }
)
