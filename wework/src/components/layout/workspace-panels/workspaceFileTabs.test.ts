import { expect, test } from 'vitest'
import { workspaceFileTabId, workspaceFileTabLabel } from './workspaceFileTabs'
import type { WorkspaceTarget } from '@/types/workspace-files'

const target: WorkspaceTarget = {
  deviceId: 'fixture-device',
  path: '/fixture/repo',
  source: 'project',
  workspaceSource: 'local',
}

test('file identity normalizes paths and does not depend on the browsing root', () => {
  expect(workspaceFileTabId(target, '/fixture/repo/src/../a.ts')).toBe(
    workspaceFileTabId({ ...target, path: '/fixture/repo/src' }, '/fixture/repo/a.ts')
  )
  expect(workspaceFileTabId(target, '/fixture/repo/a.ts')).not.toBe(
    workspaceFileTabId({ ...target, deviceId: 'other-device' }, '/fixture/repo/a.ts')
  )
  expect(workspaceFileTabId(target, '/fixture/repo/a.ts')).not.toBe(
    workspaceFileTabId({ ...target, workspaceSource: 'remote' }, '/fixture/repo/a.ts')
  )
})

test('Windows paths share a tab regardless of case or path separator', () => {
  expect(workspaceFileTabId(target, 'C:\\fixture\\repo\\A.ts')).toBe(
    workspaceFileTabId(target, 'c:/fixture/repo/a.ts')
  )
  expect(workspaceFileTabLabel('C:\\fixture\\repo\\A.ts')).toBe('A.ts')
})
