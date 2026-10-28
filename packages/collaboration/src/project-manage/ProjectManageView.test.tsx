// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { updateBoardViewTag } from '../project-board/projectTags'

import type {
  ProjectManageApi,
  ProjectManageHost,
  ProjectManageItem,
  ProjectManageMember,
  ProjectManageProject,
  ProjectManageUser,
} from './types'

type Effect = () => void | (() => void)

const hookRuntime = vi.hoisted(() => {
  let hookIndex = 0
  let hooks: Array<Record<string, unknown>> = []
  let pendingEffects: Array<{ effect: Effect; index: number }> = []

  const dependenciesChanged = (previous: unknown[] | undefined, next: unknown[]) =>
    !previous ||
    previous.length !== next.length ||
    previous.some((value, index) => !Object.is(value, next[index]))

  return {
    reset() {
      hookIndex = 0
      hooks = []
      pendingEffects = []
    },
    beginRender() {
      hookIndex = 0
      pendingEffects = []
    },
    flushEffects() {
      for (const { effect, index } of pendingEffects) {
        const hook = hooks[index]
        const cleanup = hook.cleanup
        if (typeof cleanup === 'function') cleanup()
        hook.cleanup = effect()
      }
      pendingEffects = []
    },
    useCallback<T>(callback: T, dependencies: unknown[]) {
      const index = hookIndex++
      const hook = hooks[index] ?? {}
      hooks[index] = hook
      const previous = hook.dependencies as unknown[] | undefined
      if (dependenciesChanged(previous, dependencies)) {
        hook.dependencies = dependencies
        hook.value = callback
      }
      return hook.value as T
    },
    useEffect(effect: Effect, dependencies: unknown[]) {
      const index = hookIndex++
      const hook = hooks[index] ?? {}
      hooks[index] = hook
      const previous = hook.dependencies as unknown[] | undefined
      if (dependenciesChanged(previous, dependencies)) {
        hook.dependencies = dependencies
        pendingEffects.push({ effect, index })
      }
    },
    useMemo<T>(factory: () => T, dependencies: unknown[]) {
      const index = hookIndex++
      const hook = hooks[index] ?? {}
      hooks[index] = hook
      const previous = hook.dependencies as unknown[] | undefined
      if (dependenciesChanged(previous, dependencies)) {
        hook.dependencies = dependencies
        hook.value = factory()
      }
      return hook.value as T
    },
    useRef<T>(initialValue: T) {
      const index = hookIndex++
      const hook = hooks[index] ?? { current: initialValue }
      hooks[index] = hook
      return hook as { current: T }
    },
    useState<T>(initialValue: T | (() => T)) {
      const index = hookIndex++
      const hook = hooks[index] ?? {
        value: typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue,
      }
      hooks[index] = hook
      const setValue = (next: T | ((current: T) => T)) => {
        hook.value =
          typeof next === 'function' ? (next as (current: T) => T)(hook.value as T) : next
      }
      return [hook.value as T, setValue] as const
    },
  }
})

vi.mock('react', async () => ({
  ...(await vi.importActual<typeof import('react')>('react')),
  useCallback: hookRuntime.useCallback,
  useEffect: hookRuntime.useEffect,
  useLayoutEffect: hookRuntime.useEffect,
  useMemo: hookRuntime.useMemo,
  useRef: hookRuntime.useRef,
  useState: hookRuntime.useState,
}))

import { createCollaborationTranslator } from '../i18n'
import { ProjectManageView } from './ProjectManageView'
import { ProjectMembersSection } from './ProjectMembersSection'
import { ProjectTagsSection } from './ProjectManageSections'
import type { ProjectBoardViews } from '../project-board/projectBoardViews'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function project(id: string, visibility: 'private' | 'public', version = 1): ProjectManageProject {
  return {
    id,
    name: 'Project',
    description: '',
    project_key: 'PR',
    access_role: 'Maintainer',
    task_provider: 'local',
    membership_mode: 'inherit',
    provider_config: {},
    visibility,
    tags: [],
    version,
  }
}

function createApi() {
  return {
    getProject: vi.fn(),
    listMembers: vi.fn().mockResolvedValue([]),
    listItems: vi.fn().mockResolvedValue({ items: [] }),
    searchUsers: vi.fn().mockResolvedValue({ users: [] }),
    addMember: vi.fn(),
    updateMember: vi.fn(),
    removeMember: vi.fn(),
    updateProject: vi.fn(),
  } as unknown as ProjectManageApi<
    ProjectManageProject,
    ProjectManageMember,
    ProjectManageItem,
    ProjectManageUser
  >
}

const Icon = () => null

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
    translate: (_key, fallback, options) => {
      let value = fallback
      for (const [name, replacement] of Object.entries(options ?? {})) {
        value = value.split(`{{${name}}}`).join(String(replacement))
      }
      return value
    },
    confirm: () => true,
    trackCompleted: vi.fn(),
    trackFailed: vi.fn(),
    renderTooltip: ({ children }) => children,
    renderActionMenu: () => null,
  }
}

function renderView(
  api: ReturnType<typeof createApi>,
  host: ProjectManageHost,
  currentProject: ProjectManageProject,
  onProjectUpdated: (project: ProjectManageProject) => void,
  quickAdd?: {
    requestId: number
    onConsumed(requestId: number): void
  },
  section?: 'all' | 'overview' | 'members' | 'agents' | 'board'
) {
  hookRuntime.beginRender()
  const tree = ProjectManageView({
    api,
    section,
    host,
    project: currentProject,
    onProjectUpdated,
    openMembersRequestId: quickAdd?.requestId,
    onOpenMembersRequestConsumed: quickAdd?.onConsumed,
  })
  hookRuntime.flushEffects()
  return tree
}

function findByTestId(node: unknown, testId: string): any {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findByTestId(child, testId)
      if (match) return match
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  const component = node as { type?: unknown; props?: any }
  if (component.type === ProjectMembersSection) {
    return findByTestId(ProjectMembersSection(component.props), testId)
  }
  if (component.type === ProjectTagsSection) {
    return findByTestId(ProjectTagsSection(component.props), testId)
  }
  const element = node as {
    props?: { children?: unknown; 'data-testid'?: string }
  }
  if (element.props?.['data-testid'] === testId) return element
  const children = element.props?.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = findByTestId(child, testId)
    if (match) return match
  }
  return null
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('project tag view integration', () => {
  beforeEach(() => hookRuntime.reset())
  const boardViews: ProjectBoardViews = {
    schema_version: 1,
    views: [
      {
        id: 'mixed',
        name: '测试视图',
        columns: [
          { id: 'inbox', type: 'status', value: 'inbox' },
          { id: 'test', type: 'tag', value: '测试' },
        ],
        filter: { tags: ['需求'] },
      },
    ],
  }

  it.each(['rename', 'delete'] as const)(
    'discovers unused view tags and updates their references on %s',
    async action => {
      const api = createApi()
      const host = createHost()
      host.renderActionMenu = vi.fn(() => null)
      let current = { ...project('project-a', 'private'), tags: ['bug'], board_views: boardViews }
      const onUpdated = vi.fn(updated => {
        current = updated
      })
      vi.mocked(api.updateProject).mockImplementation(async (_id, values) => ({
        ...current,
        ...values,
        board_views: values.tag_change
          ? updateBoardViewTag(
              current.board_views,
              values.tag_change.source,
              values.tag_change.target,
              host.translate
            )
          : current.board_views,
        version: values.version + 1,
      }))
      let tree = renderView(api, host, current, onUpdated)
      findByTestId(tree, 'cloud-project-manage-tags').props.onToggle({
        currentTarget: { open: true },
      })
      renderView(api, host, current, onUpdated)
      await flushPromises()
      tree = renderView(api, host, current, onUpdated)
      for (const tag of ['bug', '测试', '需求'])
        expect(findByTestId(tree, `cloud-project-tag-${tag}`)).not.toBeNull()
      expect(api.updateProject).not.toHaveBeenCalled()
      const menu = vi
        .mocked(host.renderActionMenu)
        .mock.calls.flatMap(([options]) => options.items)
        .find(item => item.testId === `cloud-project-tag-${action}-测试`)!
      if (action === 'rename') {
        menu.onSelect()
        tree = renderView(api, host, current, onUpdated)
        findByTestId(tree, 'cloud-project-tag-rename-input-测试').props.onChange({
          target: { value: '验证' },
        })
        tree = renderView(api, host, current, onUpdated)
        findByTestId(tree, 'cloud-project-tag-rename-input-测试').props.onKeyDown({ key: 'Enter' })
      } else {
        await menu.onSelect()
      }
      await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledOnce())
      expect(api.updateProject).toHaveBeenCalledWith('project-a', {
        version: 1,
        tag_change: { source: '测试', target: action === 'rename' ? '验证' : null },
      })
      tree = renderView(api, host, current, onUpdated)
      expect(findByTestId(tree, 'cloud-project-tag-测试')).toBeNull()
      expect(findByTestId(tree, 'cloud-project-tag-需求')).not.toBeNull()
    }
  )
})

describe('project tag change failures', () => {
  beforeEach(() => hookRuntime.reset())
  it.each(['rename', 'delete'] as const)(
    'keeps the catalog and Issues unchanged when %s conflicts',
    async action => {
      const api = createApi()
      const host = createHost()
      host.renderActionMenu = vi.fn(() => null)
      const current = { ...project('project-a', 'private'), tags: ['old'] }
      vi.mocked(api.listItems).mockResolvedValue({
        items: [{ id: 'issue', version: 1, tags: ['old', 'keep'] }],
      })
      vi.mocked(api.updateProject).mockRejectedValue(new Error('Project changed'))
      const onUpdated = vi.fn()
      let tree = renderView(api, host, current, onUpdated)
      findByTestId(tree, 'cloud-project-manage-tags').props.onToggle({
        currentTarget: { open: true },
      })
      renderView(api, host, current, onUpdated)
      await flushPromises()
      tree = renderView(api, host, current, onUpdated)
      expect(findByTestId(tree, 'cloud-project-tag-old')).not.toBeNull()
      const menu = vi
        .mocked(host.renderActionMenu)
        .mock.calls.flatMap(([options]) => options.items)
        .find(item => item.testId === `cloud-project-tag-${action}-old`)!
      if (action === 'rename') {
        menu.onSelect()
        tree = renderView(api, host, current, onUpdated)
        findByTestId(tree, 'cloud-project-tag-rename-input-old').props.onChange({
          target: { value: 'new' },
        })
        tree = renderView(api, host, current, onUpdated)
        findByTestId(tree, 'cloud-project-tag-rename-input-old').props.onKeyDown({ key: 'Enter' })
      } else await menu.onSelect()
      await vi.waitFor(() => expect(api.updateProject).toHaveBeenCalledOnce())
      await flushPromises()
      tree = renderView(api, host, current, onUpdated)
      expect(findByTestId(tree, 'cloud-project-manage-error').props.children).toBe(
        'Project changed'
      )
      expect(findByTestId(tree, 'cloud-project-tag-old')).not.toBeNull()
      expect(findByTestId(tree, 'cloud-project-tag-new')).toBeNull()
      expect(findByTestId(tree, 'cloud-project-tag-keep')).not.toBeNull()
      expect(onUpdated).not.toHaveBeenCalled()
      expect(api.updateProject).toHaveBeenCalledWith('project-a', {
        version: 1,
        tag_change: { source: 'old', target: action === 'rename' ? 'new' : null },
      })
    }
  )
})

describe('ProjectManageView project scope', () => {
  beforeEach(() => {
    hookRuntime.reset()
  })

  it('opens and consumes a host-requested member action', () => {
    const api = createApi()
    const host = createHost()
    const onConsumed = vi.fn()
    const currentProject = project('project-a', 'private')
    const quickAdd = { requestId: 23, onConsumed }

    renderView(api, host, currentProject, vi.fn(), quickAdd)
    const tree = renderView(api, host, currentProject, vi.fn(), quickAdd)

    expect(onConsumed).toHaveBeenCalledTimes(1)
    expect(onConsumed).toHaveBeenCalledWith(23)
    expect(findByTestId(tree, 'cloud-member-search')).toBeTruthy()
  })

  it('reloads the authoritative member list after adding a member', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    const api = createApi()
    const host = createHost()
    const owner = {
      id: 1,
      user_id: 1,
      user_name: 'owner',
      email: null,
      role: 'Owner' as const,
      capability_description: '',
    }
    const addedMember = {
      id: 2,
      user_id: 2,
      user_name: 'member',
      email: null,
      role: 'Viewer' as const,
      capability_description: '',
    }
    const user = {
      id: 2,
      user_name: 'member',
      email: null,
    }
    vi.mocked(api.listMembers)
      .mockResolvedValueOnce([owner])
      .mockResolvedValueOnce([owner, addedMember])
    vi.mocked(api.searchUsers).mockResolvedValue({ users: [user] })
    vi.mocked(api.addMember).mockResolvedValue(addedMember)
    const currentProject = project('project-a', 'private')

    try {
      let tree = renderView(api, host, currentProject, vi.fn())
      await flushPromises()
      tree = renderView(api, host, currentProject, vi.fn())

      findByTestId(tree, 'cloud-project-members-toggle').props.onClick()
      tree = renderView(api, host, currentProject, vi.fn())
      findByTestId(tree, 'cloud-member-search').props.onChange({
        target: { value: 'member' },
      })
      renderView(api, host, currentProject, vi.fn())
      await vi.advanceTimersByTimeAsync(250)
      await flushPromises()
      tree = renderView(api, host, currentProject, vi.fn())

      findByTestId(tree, 'cloud-member-role').props.onChange({
        target: { value: 'Viewer' },
      })
      tree = renderView(api, host, currentProject, vi.fn())
      findByTestId(tree, 'cloud-member-result-2').props.onClick()
      await flushPromises()
      tree = renderView(api, host, currentProject, vi.fn())

      expect(api.addMember).toHaveBeenCalledWith('project-a', 2, 'Viewer')
      expect(api.listMembers).toHaveBeenCalledTimes(2)
      expect(findByTestId(tree, 'cloud-project-member-2')).toBeTruthy()
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('explains and saves project member capabilities', async () => {
    const api = createApi()
    const host = createHost()
    const member = {
      id: 2,
      user_id: 2,
      user_name: 'member',
      email: 'member@example.com',
      role: 'Developer' as const,
      capability_description: '',
    }
    vi.mocked(api.listMembers).mockResolvedValue([member])
    vi.mocked(api.updateMember).mockResolvedValue({
      ...member,
      capability_description: '前端实现与交互验收',
    })
    const currentProject = project('project-a', 'private')

    let tree = renderView(api, host, currentProject, vi.fn())
    await flushPromises()
    tree = renderView(api, host, currentProject, vi.fn())
    findByTestId(tree, 'cloud-project-members-toggle').props.onClick()
    tree = renderView(api, host, currentProject, vi.fn())

    const capability = findByTestId(tree, 'cloud-project-member-capability-2')
    expect(capability.props.placeholder).toBe('例如：前端开发、产品验收')
    expect(capability.props['aria-label']).toBe('member 的职责与能力')
    expect(findByTestId(tree, 'cloud-project-member-capability-heading')).toBeTruthy()

    capability.props.onBlur({
      target: { value: '  前端实现与交互验收  ' },
    })
    await flushPromises()

    expect(api.updateMember).toHaveBeenCalledWith('project-a', 2, {
      capability_description: '前端实现与交互验收',
    })
  })

  it('does not apply an old self-role refresh after navigating to another project', async () => {
    const api = createApi()
    const host = createHost()
    const member: ProjectManageMember = {
      user_id: 2,
      user_name: 'member',
      email: null,
      role: 'Maintainer',
      direct_role: 'Maintainer',
      inherited_role: 'Developer',
    }
    vi.mocked(api.listMembers).mockResolvedValue([member])
    vi.mocked(api.updateMember).mockResolvedValue({
      ...member,
      role: 'Viewer',
      direct_role: 'Viewer',
    })
    const refresh = deferred<ProjectManageProject>()
    vi.mocked(api.getProject).mockReturnValue(refresh.promise)
    const projectA = { ...project('project-a', 'private'), current_user_id: 2 }
    const projectB = project('project-b', 'private')
    const onProjectUpdated = vi.fn()
    renderView(api, host, projectA, onProjectUpdated)
    await flushPromises()
    const tree = renderView(api, host, projectA, onProjectUpdated)
    findByTestId(tree, 'cloud-project-member-role-2').props.onChange({
      target: { value: 'Viewer' },
    })
    await flushPromises()
    expect(api.getProject).toHaveBeenCalledWith('project-a')

    renderView(api, host, projectB, onProjectUpdated)
    refresh.resolve({ ...projectA, access_role: 'Viewer' })
    await flushPromises()

    expect(onProjectUpdated).not.toHaveBeenCalled()
    expect(host.trackFailed).not.toHaveBeenCalled()
  })

  it('does not write an old project mutation response into the new project', async () => {
    const api = createApi()
    const host = createHost()
    const updateA = deferred<ProjectManageProject>()
    vi.mocked(api.updateProject).mockReturnValue(updateA.promise)
    const onProjectUpdated = vi.fn()
    const projectA = project('project-a', 'private')
    const projectB = project('project-b', 'private')

    let tree = renderView(api, host, projectA, onProjectUpdated)
    findByTestId(tree, 'cloud-project-manage-visibility-public').props.onClick()
    await flushPromises()

    renderView(api, host, projectB, onProjectUpdated)
    tree = renderView(api, host, projectB, onProjectUpdated)
    expect(findByTestId(tree, 'cloud-project-manage-visibility-private').props.className).toContain(
      'bg-background'
    )

    updateA.resolve(project('project-a', 'public', 2))
    await flushPromises()
    tree = renderView(api, host, projectB, onProjectUpdated)

    expect(api.updateProject).toHaveBeenCalledWith('project-a', {
      version: 1,
      visibility: 'public',
    })
    expect(onProjectUpdated).not.toHaveBeenCalled()
    expect(findByTestId(tree, 'cloud-project-manage-visibility-private').props.className).toContain(
      'bg-background'
    )
    expect(
      findByTestId(tree, 'cloud-project-manage-visibility-public').props.className
    ).not.toContain('bg-background')
  })

  it('separates public role from issue security', async () => {
    const api = createApi()
    const host = createHost()
    vi.mocked(api.updateProject).mockResolvedValue(project('project-a', 'public', 2))

    let tree = renderView(api, host, project('project-a', 'private'), vi.fn())
    findByTestId(tree, 'cloud-project-manage-visibility-public').props.onClick()
    await flushPromises()
    tree = renderView(api, host, project('project-a', 'public', 2), vi.fn())

    expect(api.updateProject).toHaveBeenCalledWith('project-a', {
      version: 1,
      visibility: 'public',
    })
    expect(findByTestId(tree, 'cloud-project-manage-visibility-public').props.className).toContain(
      'bg-background'
    )
    expect(findByTestId(tree, 'cloud-project-public-access-role')).not.toBeNull()
    expect(findByTestId(tree, 'cloud-project-default-issue-security')).not.toBeNull()
  })

  it('offers the same access settings for external projects', () => {
    const api = createApi()
    const host = createHost()
    const externalProject = {
      ...project('project-a', 'public'),
      task_provider: 'github',
    }

    const tree = renderView(api, host, externalProject, vi.fn())

    expect(findByTestId(tree, 'cloud-project-default-issue-security')).not.toBeNull()
  })

  it('uses DingTalk permissions for table records', () => {
    const tree = renderView(
      createApi(),
      createHost(),
      { ...project('project-a', 'public'), task_provider: 'dingtalk_aitable' },
      vi.fn()
    )
    expect(findByTestId(tree, 'cloud-project-public-access-role')).not.toBeNull()
    expect(findByTestId(tree, 'cloud-project-default-issue-security')).toBeNull()
  })
})

it('CP08 keeps inherited roles read-only and exposes the parent source', async () => {
  hookRuntime.reset()
  const api = createApi()
  const host = createHost()
  const current = project('inherited-project', 'private')
  vi.mocked(api.listMembers).mockResolvedValue([
    {
      user_id: 7,
      user_name: 'Space member',
      email: null,
      role: 'Maintainer',
      direct_role: null,
      inherited_role: 'Maintainer',
      inherited_from_workspace_id: 'space-1',
    },
  ])
  renderView(api, host, current, vi.fn())
  await flushPromises()
  const tree = renderView(api, host, current, vi.fn())
  expect(findByTestId(tree, 'cloud-project-member-source-7')).toBeTruthy()
  expect(findByTestId(tree, 'cloud-project-member-role-7')).toBeNull()
  expect(findByTestId(tree, 'cloud-project-member-remove-7')).toBeNull()
  expect(api.updateMember).not.toHaveBeenCalled()
})

it('CP03 saves restricted membership with the current project version', async () => {
  hookRuntime.reset()
  const api = createApi()
  const host = createHost()
  const current = project('restricted-project', 'private')
  vi.mocked(api.updateProject).mockResolvedValue({
    ...current,
    membership_mode: 'restricted',
    version: current.version + 1,
  })
  const tree = renderView(api, host, current, vi.fn())
  findByTestId(tree, 'cloud-project-membership-mode').props.onChange({
    target: { value: 'restricted' },
  })
  await flushPromises()
  expect(api.updateProject).toHaveBeenCalledWith(current.id, {
    version: current.version,
    membership_mode: 'restricted',
  })
})

it('does not offer membership mode when the old backend omits that capability', () => {
  hookRuntime.reset()
  const api = createApi()
  const current = {
    ...project('legacy-project', 'private'),
    membership_mode: undefined,
  }
  const tree = renderView(api, createHost(), current, vi.fn())
  expect(findByTestId(tree, 'cloud-project-membership-mode')).toBeNull()
  expect(api.updateProject).not.toHaveBeenCalled()
})

it('keeps member responses scoped to the project where editing started', async () => {
  hookRuntime.reset()
  const api = createApi()
  const host = createHost()
  const delayed = deferred<ProjectManageMember>()
  const member = {
    user_id: 2,
    user_name: 'Member',
    email: null,
    role: 'Developer' as const,
  }
  vi.mocked(api.listMembers).mockImplementation(async id => [
    {
      ...member,
      capability_description: id === 'project-a' ? 'Original A' : 'Original B',
    },
  ])
  vi.mocked(api.updateMember).mockReturnValue(delayed.promise)
  const a = project('project-a', 'private')
  const b = project('project-b', 'private')
  renderView(api, host, a, vi.fn())
  await flushPromises()
  let tree = renderView(api, host, a, vi.fn())
  findByTestId(tree, 'cloud-project-member-capability-2').props.onBlur({
    target: { value: 'Changed A' },
  })
  renderView(api, host, b, vi.fn())
  await flushPromises()
  delayed.resolve({ ...member, capability_description: 'Changed A' })
  await flushPromises()
  tree = renderView(api, host, b, vi.fn())
  expect(findByTestId(tree, 'cloud-project-member-capability-2').props.defaultValue).toBe(
    'Original B'
  )
  expect(findByTestId(tree, 'cloud-project-member-capability-2').props.disabled).toBe(false)
})

it('retains the existing role and releases saving controls after a rejected change', async () => {
  hookRuntime.reset()
  const api = createApi()
  const host = createHost()
  const member = {
    user_id: 2,
    user_name: 'Member',
    email: null,
    role: 'Developer' as const,
  }
  vi.mocked(api.listMembers).mockResolvedValue([member])
  vi.mocked(api.updateMember).mockRejectedValue(new Error('Permission denied'))
  const current = project('project-a', 'private')
  renderView(api, host, current, vi.fn())
  await flushPromises()
  let tree = renderView(api, host, current, vi.fn())
  findByTestId(tree, 'cloud-project-member-role-2').props.onChange({
    target: { value: 'Maintainer' },
  })
  await flushPromises()
  tree = renderView(api, host, current, vi.fn())
  expect(findByTestId(tree, 'cloud-project-member-role-2').props.value).toBe('Developer')
  expect(findByTestId(tree, 'cloud-project-member-role-2').props.disabled).toBe(false)
  expect(host.trackFailed).toHaveBeenCalledOnce()
})

it('loads only resources needed by the selected settings section', async () => {
  const api = createApi()
  const host = createHost()
  const current = project('project-a', 'private')
  renderView(api, host, current, vi.fn(), undefined, 'agents')
  await flushPromises()
  expect(api.listItems).not.toHaveBeenCalled()
  expect(api.listMembers).not.toHaveBeenCalled()
  renderView(api, host, current, vi.fn(), undefined, 'members')
  await flushPromises()
  expect(api.listMembers).toHaveBeenCalledOnce()
  expect(api.listItems).not.toHaveBeenCalled()
  renderView(api, host, current, vi.fn(), undefined, 'overview')
  await flushPromises()
  expect(api.listItems).not.toHaveBeenCalled()
  const tree = renderView(api, host, current, vi.fn(), undefined, 'overview')
  findByTestId(tree, 'cloud-project-manage-tags').props.onToggle({
    currentTarget: { open: true },
  })
  renderView(api, host, current, vi.fn(), undefined, 'overview')
  await flushPromises()
  expect(api.listItems).toHaveBeenCalledOnce()
  expect(api.listMembers).toHaveBeenCalledOnce()
})

it.each(['en', 'zh-CN'] as const)(
  'uses tag-specific %s copy for non-Error failures and recovers on retry',
  async locale => {
    const api = createApi()
    const host = createHost()
    const current = project('project-a', 'private')
    host.translate = createCollaborationTranslator(locale)
    vi.mocked(api.listItems)
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValueOnce({
        items: [{ id: 'item-1', version: 1, tags: ['task-only-tag'] }],
      })
    let tree = renderView(api, host, current, vi.fn(), undefined, 'overview')
    findByTestId(tree, 'cloud-project-manage-tags').props.onToggle({
      currentTarget: { open: true },
    })
    renderView(api, host, current, vi.fn(), undefined, 'overview')
    await flushPromises()
    tree = renderView(api, host, current, vi.fn(), undefined, 'overview')
    expect(findByTestId(tree, 'cloud-project-manage-tags-error').props.children[0]).toBe(
      locale === 'en' ? 'Failed to load tag catalog' : '加载标签目录失败'
    )
    expect(findByTestId(tree, 'cloud-project-tag-task-only-tag')).toBeNull()
    findByTestId(tree, 'cloud-project-manage-tags-retry').props.onClick()
    renderView(api, host, current, vi.fn(), undefined, 'overview')
    await flushPromises()
    tree = renderView(api, host, current, vi.fn(), undefined, 'overview')
    expect(findByTestId(tree, 'cloud-project-tag-task-only-tag')).not.toBeNull()
    expect(findByTestId(tree, 'cloud-project-manage-tags-error')).toBeNull()
    expect(api.listItems).toHaveBeenCalledTimes(2)
    renderView(api, { ...host }, current, vi.fn(), undefined, 'overview')
    await flushPromises()
    expect(api.listItems).toHaveBeenCalledTimes(2)
  }
)

it('discards late tag discovery after switching projects and leaves the next overview metadata-only', async () => {
  const api = createApi()
  const host = createHost()
  const first = project('project-a', 'private')
  const second = project('project-b', 'private')
  let resolveTags!: (result: { items: ProjectManageItem[] }) => void
  vi.mocked(api.listItems).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveTags = resolve
      })
  )
  let tree = renderView(api, host, first, vi.fn(), undefined, 'overview')
  findByTestId(tree, 'cloud-project-manage-tags').props.onToggle({
    currentTarget: { open: true },
  })
  renderView(api, host, first, vi.fn(), undefined, 'overview')
  renderView(api, host, second, vi.fn(), undefined, 'overview')
  resolveTags({
    items: [{ id: 'item-1', version: 1, tags: ['old-task-tag'] }],
  })
  await flushPromises()
  tree = renderView(api, host, second, vi.fn(), undefined, 'overview')
  expect(findByTestId(tree, 'cloud-project-tag-old-task-tag')).toBeNull()
  expect(api.listItems).toHaveBeenCalledOnce()
})

it('isolates a member load failure and retries only the member list', async () => {
  const api = createApi()
  const host = createHost()
  const current = project('project-a', 'private')
  vi.mocked(api.listMembers)
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockResolvedValueOnce([])
  const render = () => renderView(api, host, current, vi.fn(), undefined, 'members')
  render()
  await flushPromises()
  let tree = render()
  const failure = findByTestId(tree, 'cloud-project-members-error')
  expect(failure.props.children[0].props.children).toBe('加载协作数据失败')
  expect(findByTestId(tree, 'cloud-project-manage-error')).toBeNull()
  expect(findByTestId(tree, 'cloud-project-members-empty')).toBeNull()
  findByTestId(tree, 'cloud-project-members-retry').props.onClick()
  render()
  await flushPromises()
  tree = render()
  expect(findByTestId(tree, 'cloud-project-members-error')).toBeNull()
  expect(findByTestId(tree, 'cloud-project-members-empty')).not.toBeNull()
  expect(api.listMembers).toHaveBeenCalledTimes(2)
  expect(api.listItems).not.toHaveBeenCalled()
})
