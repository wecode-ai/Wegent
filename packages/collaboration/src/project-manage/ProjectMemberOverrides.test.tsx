// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { CollaborationProjectViewShell } from '../project-shell/CollaborationProjectViewShell'
import type { CollaborationProjectView } from '../workspace-header/ProjectViewSwitcher'
import { ProjectManageView } from './ProjectManageView'
import type {
  ProjectManageApi,
  ProjectManageHost,
  ProjectManageItem,
  ProjectManageMember,
  ProjectManageProject,
  ProjectManageUser,
} from './types'

type Project = ProjectManageProject & { project_store: 'backend' }
const project: Project = {
  id: 'project-1',
  name: '测试',
  description: '',
  project_key: 'PR',
  task_provider: 'local',
  provider_config: {},
  tags: [],
  version: 1,
  access_role: 'Maintainer',
  current_user_id: 1,
  membership_mode: 'inherit',
  project_store: 'backend',
  workspace_context: { id: 'space-1', name: '研发空间' },
}
const inherited: ProjectManageMember = {
  user_id: 2,
  user_name: 'member',
  email: null,
  role: 'Developer',
  direct_role: null,
  inherited_role: 'Developer',
  inherited_from_workspace_id: 'space-1',
  capability_description: '',
}
const promoted: ProjectManageMember = {
  ...inherited,
  role: 'Maintainer',
  direct_role: 'Maintainer',
}
const Icon = () => null

function createApi(members: ProjectManageMember[] = [inherited]) {
  return {
    getProject: vi.fn().mockResolvedValue(project),
    listMembers: vi.fn().mockResolvedValue(members),
    listItems: vi.fn().mockResolvedValue({ items: [] }),
    searchUsers: vi.fn().mockResolvedValue({ users: [] }),
    addMember: vi.fn(),
    updateMember: vi.fn(),
    removeMember: vi.fn().mockResolvedValue(undefined),
    updateItem: vi.fn(),
    updateProject: vi.fn(),
  } satisfies ProjectManageApi<Project, ProjectManageMember, ProjectManageItem, ProjectManageUser>
}

function createHost(): ProjectManageHost {
  return {
    icons: {
      Check: Icon,
      GitBranch: Icon,
      LockKeyhole: Icon,
      Pencil: Icon,
      Search: Icon,
      Trash2: Icon,
      X: Icon,
    },
    translate: createCollaborationTranslator('zh-CN'),
    confirm: vi.fn().mockReturnValue(true),
    trackCompleted: vi.fn(),
    trackFailed: vi.fn(),
    renderTooltip: ({ children }) => children,
    renderActionMenu: () => null,
  }
}

function ProjectScreen({
  api,
  host,
  initialProject,
  onProjectUpdated,
}: {
  api: ReturnType<typeof createApi>
  host: ProjectManageHost
  initialProject: Project
  onProjectUpdated: (project: Project) => void
}) {
  const [currentProject, setProject] = useState(initialProject)
  const [view, setView] = useState<CollaborationProjectView>('manage')
  return (
    <CollaborationProjectViewShell
      project={currentProject}
      view={view}
      onViewChange={setView}
      labels={{ board: '看板', table: '表格', files: '文件', manage: '管理' }}
      testIds={{
        board: 'view-board',
        table: 'view-table',
        files: 'view-files',
        manage: 'view-manage',
      }}
      assistantOpen={false}
      embedded
      hasCreateAction={false}
      sidebarCollapsed={false}
      title={currentProject.name}
      titleIcon={null}
      renderRightActions={() => null}
      slots={{
        board: <div data-testid="project-board" />,
        table: null,
        files: null,
        manage: (
          <ProjectManageView
            api={api}
            host={host}
            project={currentProject}
            section="members"
            onProjectUpdated={next => {
              onProjectUpdated(next)
              setProject(next)
            }}
          />
        ),
      }}
    />
  )
}

describe('Project member overrides', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  function find<T extends HTMLElement = HTMLElement>(id: string) {
    return container.querySelector<T>(`[data-testid="${id}"]`)!
  }
  async function render(api: ReturnType<typeof createApi>, initialProject = project) {
    const host = createHost()
    const onProjectUpdated = vi.fn()
    await act(async () => {
      root.render(
        <ProjectScreen
          api={api}
          host={host}
          initialProject={initialProject}
          onProjectUpdated={onProjectUpdated}
        />
      )
    })
    return { host, onProjectUpdated }
  }
  async function changeRole(role: 'Maintainer' | 'Developer' | 'Viewer') {
    await act(async () => {
      const select = find<HTMLSelectElement>('cloud-project-member-role-2')
      select.value = role
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  it('promotes an inherited member while preserving the inherited source', async () => {
    const api = createApi()
    api.updateMember.mockResolvedValue(promoted)
    await render(api)
    expect(find('cloud-project-member-remove-2')).toBeNull()
    await changeRole('Maintainer')
    expect(api.updateMember).toHaveBeenCalledWith('project-1', 2, { role: 'Maintainer' })
    expect(find('cloud-project-member-effective-role-2').textContent).toBe('管理员')
    expect(find('cloud-project-member-source-2').textContent).toBe('继承自 研发空间 · 成员')
    expect(find('cloud-project-member-remove-2')).not.toBeNull()
    expect(api.getProject).not.toHaveBeenCalled()
  })

  it('saves only responsibilities without creating a direct role', async () => {
    const api = createApi()
    api.updateMember.mockResolvedValue({ ...inherited, capability_description: '验收' })
    await render(api)
    await act(async () => {
      const input = find<HTMLInputElement>('cloud-project-member-capability-2')
      input.value = ' 验收 '
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(api.updateMember).toHaveBeenCalledWith('project-1', 2, {
      capability_description: '验收',
    })
    expect(find('cloud-project-member-remove-2')).toBeNull()
    expect(api.getProject).not.toHaveBeenCalled()
  })

  it('reloads the restored inherited row and discards an unsaved responsibility draft', async () => {
    const api = createApi([promoted])
    const { host } = await render(api)
    const input = find<HTMLInputElement>('cloud-project-member-capability-2')
    input.value = 'unsaved draft'
    api.listMembers.mockResolvedValue([inherited])
    await act(async () => find<HTMLButtonElement>('cloud-project-member-remove-2').click())
    expect(host.confirm).toHaveBeenCalledWith('移除“member”的项目角色，恢复空间角色？')
    expect(api.removeMember).toHaveBeenCalledWith('project-1', 2)
    expect(api.listMembers).toHaveBeenCalledTimes(2)
    expect(find<HTMLSelectElement>('cloud-project-member-role-2').value).toBe('Developer')
    expect(find('cloud-project-member-remove-2')).toBeNull()
    expect(find<HTMLInputElement>('cloud-project-member-capability-2').value).toBe('')
  })

  it('leaves management immediately after the current user lowers their project role', async () => {
    const api = createApi([promoted])
    api.updateMember.mockResolvedValue({ ...promoted, role: 'Viewer', direct_role: 'Viewer' })
    const authoritative = { ...project, current_user_id: 2, access_role: 'Viewer' as const }
    api.getProject.mockResolvedValue(authoritative)
    const { onProjectUpdated, host } = await render(api, { ...project, current_user_id: 2 })
    await changeRole('Viewer')
    expect(api.getProject).toHaveBeenCalledWith('project-1')
    expect(onProjectUpdated).toHaveBeenCalledWith(authoritative)
    expect(find('project-board')).not.toBeNull()
    expect(find('view-manage')).toBeNull()
    expect(find('cloud-project-member-role-2')).toBeNull()
    expect(api.listMembers).toHaveBeenCalledTimes(1)
    expect(host.trackFailed).not.toHaveBeenCalled()
  })

  it('refreshes current-user authority after removing their direct grant without a stale roster request', async () => {
    const api = createApi([promoted])
    const authoritative = { ...project, current_user_id: 2, access_role: 'Developer' as const }
    api.getProject.mockResolvedValue(authoritative)
    const { onProjectUpdated, host } = await render(api, { ...project, current_user_id: 2 })
    await act(async () => find<HTMLButtonElement>('cloud-project-member-remove-2').click())
    expect(api.removeMember).toHaveBeenCalledWith('project-1', 2)
    expect(onProjectUpdated).toHaveBeenCalledWith(authoritative)
    expect(find('project-board')).not.toBeNull()
    expect(find('view-manage')).toBeNull()
    expect(api.listMembers).toHaveBeenCalledTimes(1)
    expect(host.trackFailed).not.toHaveBeenCalled()
  })

  it('keeps space-administrator authority after removing their lower direct role', async () => {
    const admin: ProjectManageMember = {
      ...promoted,
      direct_role: 'Viewer',
      inherited_role: 'Maintainer',
    }
    const api = createApi([admin])
    const authoritative = { ...project, current_user_id: 2 }
    api.getProject.mockResolvedValue(authoritative)
    const { onProjectUpdated } = await render(api, authoritative)
    api.listMembers.mockResolvedValue([{ ...admin, direct_role: null }])
    await act(async () => find<HTMLButtonElement>('cloud-project-member-remove-2').click())
    expect(onProjectUpdated).toHaveBeenCalledWith(authoritative)
    expect(find('view-manage')).not.toBeNull()
    expect(find('project-board')).toBeNull()
    expect(api.listMembers).toHaveBeenCalledTimes(2)
    expect(find('cloud-project-member-role-2')).toBeNull()
    expect(find('cloud-project-member-effective-role-2').textContent).toBe('管理员')
  })
})
