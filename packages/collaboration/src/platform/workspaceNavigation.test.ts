import { expect, it } from 'vitest'
import { buildWorkspaceNavigation } from './workspaceNavigation'
import type { CollaborationProject, CollaborationWorkspace } from '../types'

it('pins the personal system default before other spaces without regrouping their projects', () => {
  const spaces = [
    { id: 'business', name: '业务空间' },
    { id: 'personal', name: '默认空间', is_system_default: true },
    { id: 'another', name: '其他空间' },
  ] as CollaborationWorkspace[]
  const projects = [
    { id: 'mine', workspace_id: 'personal' },
    {
      id: 'shared',
      workspace_id: 'guest',
      workspace_context: {
        id: 'guest',
        name: '默认空间',
        public_id: 'guest-public',
      },
    },
  ] as CollaborationProject[]
  const result = buildWorkspaceNavigation(spaces, projects, null)
  expect(result.workspaces.map(entry => entry.workspace.id)).toEqual([
    'personal',
    'business',
    'another',
    'guest',
  ])
  expect(result.projectsByWorkspace.get('personal')).toEqual([projects[0]])
  expect(result.projectsByWorkspace.get('guest')).toEqual([projects[1]])
  expect(result.workspaces.at(-1)?.canOpen).toBe(false)
  expect(spaces[0].id).toBe('business')
})
