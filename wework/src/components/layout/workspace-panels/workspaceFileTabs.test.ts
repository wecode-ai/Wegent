// @vitest-environment node

import type { WorkspaceTarget } from '@/types/workspace-files'
import { expect, test } from 'vitest'
import { workspaceFileTabId, workspaceFileTabLabel } from './workspaceFileTabs'

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

test('POSIX backslashes remain part of the filename and tab identity', () => {
  const path = String.raw`/fixture/repo/report\2026.md`
  expect(workspaceFileTabLabel(path)).toBe(String.raw`report\2026.md`)
  expect(workspaceFileTabId(target, path)).not.toBe(
    workspaceFileTabId(target, '/fixture/repo/report/2026.md')
  )
})
