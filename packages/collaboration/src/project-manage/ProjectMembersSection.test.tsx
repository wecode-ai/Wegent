// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { ProjectMembersSection } from './ProjectMembersSection'
import type { ProjectManageHost, ProjectManageMember, ProjectManageProject } from './types'

const Icon = () => <svg aria-hidden="true" />
const project: ProjectManageProject = {
  id: 'project-1',
  name: '测试',
  description: '',
  project_key: 'PR',
  task_provider: 'local',
  provider_config: {},
  tags: [],
  version: 1,
  access_role: 'Maintainer',
  membership_mode: 'inherit',
  workspace_context: { id: '165', name: '研发空间' },
}
const inherited: ProjectManageMember = {
  user_id: 1,
  user_name: 'admin',
  email: 'admin@example.com',
  role: 'Maintainer',
  direct_role: null,
  inherited_role: 'Maintainer',
  inherited_from_workspace_id: '165',
}
const direct: ProjectManageMember = {
  user_id: 2,
  user_name: 'hongyu9',
  email: 'hongyu9@example.com',
  role: 'Developer',
  direct_role: 'Developer',
  inherited_role: null,
}

function makeController(members = [inherited, direct]) {
  return {
    members,
    loading: false,
    loadError: null as string | null,
    retryLoad: vi.fn(),
    membersOpen: false,
    setMembersOpen: vi.fn(),
    memberComposerRef: createRef<HTMLDivElement>(),
    memberQuery: '',
    setMemberQuery: vi.fn(),
    memberSearchInputRef: createRef<HTMLInputElement>(),
    memberResults: [],
    memberRole: 'Developer' as const,
    setMemberRole: vi.fn(),
    savingUserId: null as number | null,
    addMember: vi.fn(),
    removeMember: vi.fn(),
    updateMember: vi.fn(),
    updateMemberCapability: vi.fn(),
  }
}

describe('Project member settings presentation', () => {
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
  async function render(
    options: {
      members?: ProjectManageMember[]
      canManage?: boolean
      loading?: boolean
      locale?: 'zh-CN' | 'en'
      project?: ProjectManageProject
      savingUserId?: number
    } = {}
  ) {
    const controller = makeController(options.members)
    controller.loading = options.loading ?? false
    controller.savingUserId = options.savingUserId ?? null
    const host: ProjectManageHost = {
      icons: {
        Check: Icon,
        GitBranch: Icon,
        LockKeyhole: Icon,
        Pencil: Icon,
        Search: Icon,
        Trash2: Icon,
        X: Icon,
      },
      translate: createCollaborationTranslator(options.locale ?? 'zh-CN'),
      confirm: () => true,
      trackCompleted: vi.fn(),
      trackFailed: vi.fn(),
      renderTooltip: ({ children }) => children,
      renderActionMenu: () => null,
    }
    const onMembershipModeChange = vi.fn()
    await act(async () =>
      root.render(
        <ProjectMembersSection
          project={options.project ?? project}
          host={host}
          controller={controller}
          canManage={options.canManage ?? true}
          membershipModeBusy={false}
          onMembershipModeChange={onMembershipModeChange}
        />
      )
    )
    return { controller, onMembershipModeChange }
  }
  function find<T extends HTMLElement = HTMLElement>(id: string) {
    return container.querySelector<T>(`[data-testid="${id}"]`)!
  }

  it('keeps each member in four cells, with a localized role and named source', async () => {
    await render()
    const row = find('cloud-project-member-1')
    expect(
      row.querySelectorAll(':scope > [role="cell"], :scope > [role="rowheader"]')
    ).toHaveLength(4)
    expect(find('cloud-project-member-effective-role-1').textContent).toContain('管理员')
    expect(find('cloud-project-member-source-1').textContent).toBe('继承自 研发空间 · 管理员')
    expect(row.textContent).not.toContain('Maintainer')
    expect(row.textContent).not.toContain('165')
    expect(find('cloud-project-member-role-1')).toBeNull()
    expect(find('cloud-project-member-remove-1')).toBeNull()
    expect(find('cloud-project-member-count').textContent).toBe('2')
  })

  it('uses the parent-space label when its name is unavailable, without showing an ID', async () => {
    await render({ project: { ...project, workspace_context: undefined } })
    expect(find('cloud-project-member-source-1').textContent).toBe('继承自父空间 · 管理员')
  })

  it('preserves the effective inherited role while editing a lower direct role', async () => {
    const { controller } = await render({
      members: [{ ...inherited, direct_role: 'Viewer' }],
    })
    expect(find('cloud-project-member-effective-role-1').textContent).toContain('管理员')
    const select = find<HTMLSelectElement>('cloud-project-member-role-1')
    expect(select.value).toBe('Viewer')
    await act(async () => {
      select.value = 'Developer'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(controller.updateMember).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 1 }),
      'Developer'
    )
    expect(find('cloud-project-member-source-1').textContent).toBe('继承自 研发空间 · 管理员')
    expect(find('cloud-project-member-remove-1')).not.toBeNull()
  })

  it.each(['Developer', 'Viewer'] as const)(
    'allows a project override for an inherited %s without exposing removal',
    async role => {
      const member = { ...inherited, role, inherited_role: role }
      const { controller } = await render({ members: [member] })
      const select = find<HTMLSelectElement>('cloud-project-member-role-1')
      expect(select.value).toBe(role)
      expect(select.disabled).toBe(false)
      expect(find('cloud-project-member-remove-1')).toBeNull()
      await act(async () => {
        select.value = 'Maintainer'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(controller.updateMember).toHaveBeenCalledWith(member, 'Maintainer')
    }
  )

  it('distinguishes a lower project override from the inherited member role', async () => {
    await render({
      members: [
        { ...inherited, role: 'Viewer', inherited_role: 'Developer', direct_role: 'Viewer' },
      ],
    })
    expect(find('cloud-project-member-effective-role-1').textContent).toBe('只读成员')
    expect(find('cloud-project-member-source-1').textContent).toBe('继承自 研发空间 · 成员')
    expect(find<HTMLSelectElement>('cloud-project-member-role-1').value).toBe('Viewer')
    expect(find('cloud-project-member-remove-1').getAttribute('aria-label')).toBe(
      '恢复 admin 的空间角色'
    )
  })

  it('allows a manager to edit inherited members’ project responsibilities without editing their role', async () => {
    const { controller } = await render()
    const input = find<HTMLInputElement>('cloud-project-member-capability-1')
    expect(input.disabled).toBe(false)
    await act(async () => {
      input.value = '前端开发'
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(controller.updateMemberCapability).toHaveBeenCalledWith(inherited, '前端开发')
    expect(controller.updateMember).not.toHaveBeenCalled()
  })

  it('shows read-only members without exposing management controls', async () => {
    await render({ canManage: false })
    expect(find('cloud-project-members-toggle')).toBeNull()
    expect(find('cloud-project-member-role-2')).toBeNull()
    expect(find('cloud-project-member-remove-2')).toBeNull()
    expect(find<HTMLInputElement>('cloud-project-member-capability-2').disabled).toBe(true)
    expect(find<HTMLSelectElement>('cloud-project-membership-mode').disabled).toBe(true)
    expect(find('cloud-project-member-effective-role-2').textContent).toBe('成员')
  })

  it('explains restricted membership and saves the selected mode', async () => {
    const { onMembershipModeChange } = await render({
      project: { ...project, membership_mode: 'restricted' },
    })
    expect(find('cloud-project-membership-hint').textContent).toContain('空间管理员')
    const select = find<HTMLSelectElement>('cloud-project-membership-mode')
    await act(async () => {
      select.value = 'inherit'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onMembershipModeChange).toHaveBeenCalledWith('inherit')
    expect(select.getAttribute('aria-describedby')).toBe('cloud-project-membership-hint')
  })

  it('keeps loading and an empty roster distinct', async () => {
    await render({ members: [], loading: true })
    expect(find('cloud-project-members-loading')).not.toBeNull()
    expect(find('cloud-project-members-empty')).toBeNull()
    await render({ members: [] })
    expect(find('cloud-project-members-loading')).toBeNull()
    expect(find('cloud-project-members-empty').textContent).toBe('暂无项目成员')
  })

  it('disables mutation controls while a member change is saving', async () => {
    await render({ savingUserId: 2 })
    expect(find<HTMLSelectElement>('cloud-project-member-role-2').disabled).toBe(true)
    expect(find<HTMLButtonElement>('cloud-project-member-remove-2').disabled).toBe(true)
    expect(find<HTMLInputElement>('cloud-project-member-capability-1').disabled).toBe(true)
  })

  it('localizes role names and permission guidance in English', async () => {
    await render({ locale: 'en' })
    expect(find('cloud-project-member-effective-role-1').textContent).toContain('Administrator')
    expect(find('cloud-project-member-source-1').textContent).toBe(
      'Inherited from 研发空间 · Administrator'
    )
    expect(find('cloud-project-members-inheritance-note').textContent).toContain(
      'Space administrators always manage the project'
    )
  })
})
