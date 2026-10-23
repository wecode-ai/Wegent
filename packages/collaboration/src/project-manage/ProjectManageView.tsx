// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from 'react'
import { BoardLayoutEditor } from './BoardLayoutEditor'
import { ProjectProviderSection, ProjectTagsSection } from './ProjectManageSections'
import { ProjectMembersSection } from './ProjectMembersSection'
import { useProjectMembers } from './useProjectMembers'
import {
  createProjectVersionMutationQueue,
  type ProjectVersionMutationQueue,
} from './projectMutationQueue'
import { repositoryAddress, repositoryProviderConfig } from './provider'
import { collectProjectTags, updateBoardViewTag } from '../project-board/projectTags'
import type {
  ProjectManageApi,
  ProjectManageCardDisplay,
  ProjectManageExtensionContext,
  ProjectManageHost,
  ProjectManageItem,
  ProjectManageMember,
  ProjectManageProject,
  ProjectManageStatus,
  ProjectManageUpdate,
  ProjectManageUser,
  ProjectManageVisibility,
} from './types'

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

function initialDisplay(
  project: ProjectManageProject,
  display?: ProjectManageCardDisplay
): ProjectManageCardDisplay {
  return (
    display ?? {
      showAssignee: project.card_display?.show_assignee ?? true,
      showPriority: project.card_display?.show_priority ?? true,
      showTags: project.card_display?.show_tags ?? true,
      showDate: project.card_display?.show_date ?? true,
    }
  )
}

export function ProjectManageView<
  Project extends ProjectManageProject,
  Member extends ProjectManageMember,
  Item extends ProjectManageItem,
  User extends ProjectManageUser,
>({
  api,
  host,
  project,
  boardCardDisplay,
  embedded = false,
  section = 'all',
  renderProviderSettings,
  providerSettingsSection = 'agents',
  onProjectUpdated,
  openMembersRequestId,
  onOpenMembersRequestConsumed,
}: {
  api: ProjectManageApi<Project, Member, Item, User>
  host: ProjectManageHost
  project: Project
  boardCardDisplay?: ProjectManageCardDisplay
  embedded?: boolean
  section?: 'all' | 'overview' | 'members' | 'agents' | 'board'
  renderProviderSettings?(context: ProjectManageExtensionContext<Project>): React.ReactNode
  providerSettingsSection?: 'overview' | 'agents'
  onProjectUpdated?(project: Project): void
  openMembersRequestId?: number
  onOpenMembersRequestConsumed?(requestId: number): void
}) {
  const { GitBranch, LockKeyhole } = host.icons
  const [error, setError] = useState<string | null>(null)
  const [itemResult, setItemResult] = useState<{
    projectId: string
    items: Item[]
  }>({
    projectId: project.id,
    items: [],
  })
  const items = useMemo(
    () => (itemResult.projectId === project.id ? itemResult.items : []),
    [itemResult, project.id]
  )
  const setItems = useCallback(
    (next: SetStateAction<Item[]>) => {
      setItemResult(current => ({
        projectId: project.id,
        items:
          typeof next === 'function'
            ? next(current.projectId === project.id ? current.items : [])
            : next,
      }))
    },
    [project.id]
  )
  const [tags, setTags] = useState(project.tags ?? [])
  const [display, setDisplay] = useState(() => initialDisplay(project, boardCardDisplay))
  const [statuses, setStatuses] = useState<ProjectManageStatus[]>(
    project.board_config?.statuses ?? []
  )
  const [visibility, setVisibility] = useState<ProjectManageVisibility>(
    project.visibility ?? 'private'
  )
  const [publicAccessRole, setPublicAccessRole] = useState<'Viewer'>(
    project.public_access?.role ?? 'Viewer'
  )
  const [defaultIssueSecurity, setDefaultIssueSecurity] = useState<'open' | 'related'>(
    project.default_issue_security ?? 'open'
  )

  const [tagComposerOpen, setTagComposerOpen] = useState(false)
  const [newTag, setNewTag] = useState('')
  const [renamingTag, setRenamingTag] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [tagBusy, setTagBusy] = useState(false)
  const [tagCatalogProjectId, setTagCatalogProjectId] = useState<string | null>(null)
  const [tagLoadRevision, setTagLoadRevision] = useState(0)
  const [tagLoadState, setTagLoadState] = useState<{
    projectId: string
    error: string | null
    loading: boolean
  } | null>(null)
  const [displayBusy, setDisplayBusy] = useState(false)
  const [statusBusy, setStatusBusy] = useState(false)
  const [visibilityBusy, setVisibilityBusy] = useState(false)

  const externalProvider =
    project.task_provider === 'github' || project.task_provider === 'gitlab'
      ? project.task_provider
      : null
  const visibilityOptions: ProjectManageVisibility[] = ['private', 'public']
  const visibilityLabels: Record<ProjectManageVisibility, string> = {
    private: host.translate('todo.private_project', '私有项目'),
    public: host.translate('todo.public_project', '公开项目'),
  }
  const visibilityDescriptions: Record<ProjectManageVisibility, string> = {
    private: host.translate('todo.private_project_description', '仅项目成员可以进入。'),
    public: host.translate(
      'todo.public_project_description',
      '所有登录用户按所选角色进入；任务可见范围由安全级别控制。'
    ),
  }
  const [providerRepository, setProviderRepository] = useState(() => repositoryAddress(project))
  const [providerToken, setProviderToken] = useState('')
  const [providerBusy, setProviderBusy] = useState(false)
  const [providerSaved, setProviderSaved] = useState(false)
  const synchronizedProjectIdRef = useRef(project.id)
  const synchronizedProjectVersionRef = useRef(project.version)
  const [savedProjectScope, setSavedProjectScope] = useState<{
    projectId: string
    mutationQueue: ProjectVersionMutationQueue<Project>
  }>(() => ({
    projectId: project.id,
    mutationQueue: createProjectVersionMutationQueue(project.version),
  }))
  let projectScope = savedProjectScope
  if (savedProjectScope.projectId !== project.id) {
    projectScope = {
      projectId: project.id,
      mutationQueue: createProjectVersionMutationQueue(project.version),
    }
    setSavedProjectScope(projectScope)
  }
  const projectScopeRef = useRef(projectScope)
  useLayoutEffect(() => {
    projectScopeRef.current = projectScope
  }, [projectScope])
  const dirtyRef = useRef({
    tags: false,
    display: false,
    statuses: false,
    visibility: false,
    providerRepository: false,
    providerToken: false,
  })

  useEffect(() => {
    const projectChanged = synchronizedProjectIdRef.current !== project.id
    synchronizedProjectIdRef.current = project.id
    if (!projectChanged) projectScopeRef.current.mutationQueue.synchronize(project.version)

    if (projectChanged) {
      synchronizedProjectVersionRef.current = project.version
      dirtyRef.current = {
        tags: false,
        display: false,
        statuses: false,
        visibility: false,
        providerRepository: false,
        providerToken: false,
      }
      setTags(project.tags ?? [])
      setDisplay(initialDisplay(project, boardCardDisplay))
      setStatuses(project.board_config?.statuses ?? [])
      setVisibility(project.visibility ?? 'private')
      setPublicAccessRole(project.public_access?.role ?? 'Viewer')
      setDefaultIssueSecurity(project.default_issue_security ?? 'open')
      setProviderRepository(repositoryAddress(project))
      setProviderToken('')
      setProviderBusy(false)
      setProviderSaved(false)
      setError(null)
      setTagComposerOpen(false)
      setNewTag('')
      setRenamingTag(null)
      setRenameValue('')
      setTagBusy(false)
      setTagCatalogProjectId(null)
      setTagLoadState(null)
      setDisplayBusy(false)
      setStatusBusy(false)
      setVisibilityBusy(false)
      return
    }

    const serverVersionChanged = synchronizedProjectVersionRef.current !== project.version
    synchronizedProjectVersionRef.current = project.version
    if (!serverVersionChanged) return

    if (!dirtyRef.current.tags) setTags(project.tags ?? [])
    if (!dirtyRef.current.display) setDisplay(initialDisplay(project, boardCardDisplay))
    if (!dirtyRef.current.statuses) setStatuses(project.board_config?.statuses ?? [])
    if (!dirtyRef.current.visibility) {
      setVisibility(project.visibility ?? 'private')
      setPublicAccessRole(project.public_access?.role ?? 'Viewer')
      setDefaultIssueSecurity(project.default_issue_security ?? 'open')
    }
    if (!dirtyRef.current.providerRepository) {
      setProviderRepository(repositoryAddress(project))
    }
    if (!dirtyRef.current.providerToken) {
      setProviderToken('')
    }
  }, [boardCardDisplay, project])

  const reportError = useCallback((cause: unknown, fallback: string) => {
    setError(cause instanceof Error ? cause.message : fallback)
  }, [])

  const canManageMembers = project.access_role === 'Owner' || project.access_role === 'Maintainer'
  const memberController = useProjectMembers({
    api,
    host,
    projectId: project.id,
    currentUserId: project.current_user_id,
    onProjectUpdated,
    projectScopeRef,
    canManage: canManageMembers,
    enabled: section === 'all' || section === 'members',
    reportError,
    openMembersRequestId,
    onOpenMembersRequestConsumed,
  })

  const tagLoadFailed = host.translate('todo.load_tag_catalog_failed', '加载标签目录失败')
  useEffect(() => {
    if (tagCatalogProjectId !== project.id || (section !== 'all' && section !== 'overview')) return
    let active = true
    setTagLoadState({ projectId: project.id, loading: true, error: null })
    void api.listItems(project.id).then(
      response => {
        if (!active) return
        setItems(response.items)
        setTagLoadState({ projectId: project.id, loading: false, error: null })
      },
      cause => {
        if (!active) return
        setTagLoadState({
          projectId: project.id,
          loading: false,
          error: cause instanceof Error ? cause.message : tagLoadFailed,
        })
      }
    )
    return () => {
      active = false
    }
  }, [api, project.id, section, setItems, tagCatalogProjectId, tagLoadFailed, tagLoadRevision])

  const allTags = useMemo(
    () => collectProjectTags({ tags, board_views: project.board_views }, items),
    [items, tags, project.board_views]
  )
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) {
      for (const tag of item.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return counts
  }, [items])

  async function updateProject(
    values: Omit<ProjectManageUpdate, 'version'>,
    scope: typeof projectScope
  ): Promise<Project> {
    return scope.mutationQueue.enqueue(
      async version => {
        if (values.board_views && version !== project.version) {
          throw new Error(
            host.translate('todo.board_view_conflict', '项目已被更新，请刷新后重试。')
          )
        }
        const updated = await api.updateProject(scope.projectId, {
          ...values,
          version,
        })
        if (projectScopeRef.current === scope) onProjectUpdated?.(updated)
        return updated
      },
      updated => updated.version
    )
  }

  async function saveVisibility(next: ProjectManageVisibility) {
    if (visibilityBusy || visibility === next) return
    const scope = projectScopeRef.current
    const previous = visibility
    dirtyRef.current.visibility = true
    setVisibility(next)
    setVisibilityBusy(true)
    try {
      const updated = await updateProject({ visibility: next }, scope)
      if (projectScopeRef.current !== scope) return
      setVisibility(updated.visibility ?? next)
      setPublicAccessRole(updated.public_access?.role ?? 'Viewer')
      dirtyRef.current.visibility = false
      host.trackCompleted('update')
    } catch (cause) {
      if (projectScopeRef.current !== scope) return
      host.trackFailed()
      dirtyRef.current.visibility = false
      setVisibility(previous)
      reportError(cause, host.translate('todo.update_visibility_failed', '更新项目权限失败'))
    } finally {
      if (projectScopeRef.current === scope) setVisibilityBusy(false)
    }
  }

  async function saveAccessSettings(
    values: Pick<
      ProjectManageUpdate,
      'public_access' | 'default_issue_security' | 'membership_mode'
    >
  ) {
    if (visibilityBusy) return
    const scope = projectScopeRef.current
    setVisibilityBusy(true)
    dirtyRef.current.visibility = true
    try {
      const updated = await updateProject(values, scope)
      if (projectScopeRef.current !== scope) return
      setPublicAccessRole(updated.public_access?.role ?? 'Viewer')
      setDefaultIssueSecurity(updated.default_issue_security ?? 'open')
      host.trackCompleted('update')
    } catch (cause) {
      if (projectScopeRef.current !== scope) return
      reportError(cause, host.translate('todo.update_visibility_failed', '更新项目权限失败'))
    } finally {
      if (projectScopeRef.current === scope) {
        dirtyRef.current.visibility = false
        setVisibilityBusy(false)
      }
    }
  }

  async function saveDisplay(key: keyof ProjectManageCardDisplay, checked: boolean) {
    if (displayBusy) return
    const scope = projectScopeRef.current
    const previous = display
    const next = { ...display, [key]: checked }
    dirtyRef.current.display = true
    setDisplay(next)
    setDisplayBusy(true)
    try {
      await updateProject(
        {
          card_display: {
            show_assignee: next.showAssignee,
            show_priority: next.showPriority,
            show_tags: next.showTags,
            show_date: next.showDate,
          },
        },
        scope
      )
      if (projectScopeRef.current !== scope) return
      dirtyRef.current.display = false
      host.trackCompleted('update')
    } catch (cause) {
      if (projectScopeRef.current !== scope) return
      host.trackFailed()
      dirtyRef.current.display = false
      setDisplay(previous)
      reportError(cause, host.translate('todo.save_card_display_failed', '保存卡片显示设置失败'))
    } finally {
      if (projectScopeRef.current === scope) setDisplayBusy(false)
    }
  }

  async function saveStatuses(next: ProjectManageStatus[]) {
    if (statusBusy) return
    const scope = projectScopeRef.current
    const previous = statuses
    dirtyRef.current.statuses = true
    setStatuses(next)
    setStatusBusy(true)
    try {
      const updated = await updateProject(
        {
          board_config: {
            ...project.board_config,
            group_by: project.board_config?.group_by ?? 'status',
            statuses: next,
            processing_start_status_id: project.board_config?.processing_start_status_id ?? null,
          },
        },
        scope
      )
      if (projectScopeRef.current !== scope) return
      setStatuses(updated.board_config?.statuses ?? next)
      dirtyRef.current.statuses = false
      host.trackCompleted('update')
    } catch (cause) {
      if (projectScopeRef.current !== scope) return
      host.trackFailed()
      dirtyRef.current.statuses = false
      setStatuses(previous)
      reportError(cause, host.translate('todo.save_statuses_failed', '保存状态设置失败'))
    } finally {
      if (projectScopeRef.current === scope) setStatusBusy(false)
    }
  }

  async function persistTags(
    next: string[],
    scope: typeof projectScope,
    boardViews?: ProjectManageUpdate['board_views']
  ) {
    dirtyRef.current.tags = true
    try {
      const updated = await updateProject(
        { tags: next, ...(boardViews ? { board_views: boardViews } : {}) },
        scope
      )
      if (projectScopeRef.current !== scope) return
      setTags(updated.tags ?? next)
    } finally {
      if (projectScopeRef.current === scope) dirtyRef.current.tags = false
    }
  }

  async function createTag() {
    const value = newTag.trim()
    if (!value || tagBusy) return
    const scope = projectScopeRef.current
    setTagBusy(true)
    try {
      if (!allTags.includes(value)) await persistTags([...tags, value], scope)
      if (projectScopeRef.current !== scope) return
      setNewTag('')
      setTagComposerOpen(false)
    } catch (cause) {
      if (projectScopeRef.current !== scope) return
      reportError(cause, host.translate('todo.create_tag_failed', '新建标签失败'))
    } finally {
      if (projectScopeRef.current === scope) setTagBusy(false)
    }
  }

  async function renameTag(source: string) {
    const target = renameValue.trim()
    setRenamingTag(null)
    if (!target || target === source || allTags.includes(target)) return
    const scope = projectScopeRef.current
    setTagBusy(true)
    try {
      const boardViews = updateBoardViewTag(project.board_views, source, target, host.translate)
      const changed = await Promise.all(
        items
          .filter(item => (item.tags ?? []).includes(source))
          .map(item =>
            api.updateItem(item.id, {
              version: item.version,
              tags: (item.tags ?? []).map(tag => (tag === source ? target : tag)),
            })
          )
      )
      if (projectScopeRef.current !== scope) return
      setItems(current => current.map(item => changed.find(next => next.id === item.id) ?? item))
      if (tags.includes(source) || boardViews) {
        await persistTags(
          tags.map(tag => (tag === source ? target : tag)),
          scope,
          boardViews
        )
      }
    } catch (cause) {
      if (projectScopeRef.current !== scope) return
      reportError(cause, host.translate('todo.rename_tag_failed', '重命名标签失败'))
    } finally {
      if (projectScopeRef.current === scope) setTagBusy(false)
    }
  }

  async function deleteTag(tag: string) {
    let boardViews: ProjectManageUpdate['board_views']
    try {
      boardViews = updateBoardViewTag(project.board_views, tag, null, host.translate)
    } catch (cause) {
      reportError(cause, host.translate('todo.delete_tag_failed', '删除标签失败'))
      return
    }
    const count = tagCounts.get(tag) ?? 0
    if (
      !host.confirm(
        host.translate('todo.delete_tag_confirm', '删除标签“{{tag}}”{{suffix}}？', {
          tag,
          suffix:
            (count
              ? host.translate('todo.delete_tag_usage_suffix', '，并从 {{count}} 个任务上移除', {
                  count,
                })
              : '') +
            (boardViews
              ? host.translate('todo.delete_tag_view_suffix', '，并从所有视图的泳道和筛选中移除')
              : ''),
        })
      )
    ) {
      return
    }
    const scope = projectScopeRef.current
    setTagBusy(true)
    try {
      const changed = await Promise.all(
        items
          .filter(item => (item.tags ?? []).includes(tag))
          .map(item =>
            api.updateItem(item.id, {
              version: item.version,
              tags: (item.tags ?? []).filter(value => value !== tag),
            })
          )
      )
      if (projectScopeRef.current !== scope) return
      setItems(current => current.map(item => changed.find(next => next.id === item.id) ?? item))
      if (tags.includes(tag) || boardViews) {
        await persistTags(
          tags.filter(value => value !== tag),
          scope,
          boardViews
        )
      }
    } catch (cause) {
      if (projectScopeRef.current !== scope) return
      reportError(cause, host.translate('todo.delete_tag_failed', '删除标签失败'))
    } finally {
      if (projectScopeRef.current === scope) setTagBusy(false)
    }
  }

  async function saveProvider() {
    if (!externalProvider || providerBusy) return
    const scope = projectScopeRef.current
    setProviderBusy(true)
    setProviderSaved(false)
    try {
      const updated = await updateProject(
        {
          provider_config: {
            ...repositoryProviderConfig(providerRepository, externalProvider),
            ...(providerToken.trim() ? { token: providerToken.trim() } : {}),
          },
        },
        scope
      )
      if (projectScopeRef.current !== scope) return
      setProviderRepository(repositoryAddress(updated))
      setProviderToken('')
      dirtyRef.current.providerRepository = false
      dirtyRef.current.providerToken = false
      setProviderSaved(true)
    } catch (cause) {
      if (projectScopeRef.current !== scope) return
      reportError(cause, host.translate('todo.save_provider_failed', '保存任务来源失败'))
    } finally {
      if (projectScopeRef.current === scope) setProviderBusy(false)
    }
  }

  return (
    <div className={embedded ? 'min-h-0' : 'min-h-0 flex-1 overflow-y-auto px-8 py-7'}>
      <div className={embedded ? '' : 'mx-auto max-w-[900px]'}>
        {!embedded && section !== 'members' ? (
          <header className="pb-7">
            <h1 className="text-heading-lg font-semibold">
              {section === 'agents'
                ? host.translate('todo.project_agents', '智能体')
                : section === 'board'
                  ? host.translate('todo.board_settings', '看板设置')
                  : host.translate('todo.project_basic_information', '基本信息')}
            </h1>
            <p className="mt-1 text-sm text-text-muted">
              {section === 'agents'
                ? host.translate(
                    'todo.project_agents_description',
                    '管理当前项目可以分配和调度的智能体。'
                  )
                : section === 'board'
                  ? host.translate(
                      'todo.board_layout_edit_description',
                      '调整状态顺序和任务卡展示字段。'
                    )
                  : host.translate(
                      'todo.project_basic_information_description',
                      '管理项目属性、标签与任务来源。'
                    )}
            </p>
          </header>
        ) : null}

        {(section === 'all' || section === 'overview') && (
          <section className="border-t border-border py-6">
            <h2 className="text-heading-md font-semibold">
              {host.translate('todo.project_information', '项目信息')}
            </h2>
            <dl className="mt-4 grid gap-4 rounded-xl bg-muted px-4 py-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-text-muted">
                  {host.translate('todo.project_name', '项目名称')}
                </dt>
                <dd className="mt-1 text-sm font-medium">{project.name}</dd>
              </div>
              <div>
                <dt className="text-xs text-text-muted">
                  {host.translate('todo.project_identifier', '项目标识')}
                </dt>
                <dd className="mt-1 text-sm font-medium">{project.project_key}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-text-muted">
                  {host.translate('todo.project_description', '项目说明')}
                </dt>
                <dd className="mt-1 text-sm">
                  {project.description ||
                    host.translate('todo.project_description_empty', '暂无说明')}
                </dd>
              </div>
            </dl>
          </section>
        )}

        {(section === 'all' || section === 'overview') && (
          <section className="border-t border-border py-6">
            <h2 className="text-heading-md font-semibold">
              {host.translate('todo.project_access', '项目访问范围')}
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              {host.translate(
                'todo.project_access_description',
                '决定谁能进入项目，以及普通用户可以看到哪些任务。'
              )}
            </p>
            <div
              className={classNames(
                'mt-4 grid gap-1 rounded-lg bg-muted p-1',
                'max-w-md grid-cols-2'
              )}
            >
              {visibilityOptions.map(value => (
                <button
                  key={value}
                  type="button"
                  data-testid={`cloud-project-manage-visibility-${value.replace('_', '-')}`}
                  disabled={visibilityBusy}
                  onClick={() => void saveVisibility(value)}
                  className={classNames(
                    'h-8 rounded-md text-xs',
                    visibility === value ? 'bg-background shadow-sm' : 'text-text-muted'
                  )}
                >
                  {visibilityLabels[value]}
                </button>
              ))}
            </div>
            <p className="mt-2 text-sm text-text-muted">{visibilityDescriptions[visibility]}</p>
            {visibility === 'public' && (
              <label className="mt-4 flex items-center justify-between gap-3 text-sm">
                <span>{host.translate('todo.public_access_role', '所有登录用户的角色')}</span>
                <select
                  data-testid="cloud-project-public-access-role"
                  value={publicAccessRole}
                  disabled={visibilityBusy}
                  onChange={event =>
                    void saveAccessSettings({
                      public_access: {
                        role: event.target.value as 'Viewer',
                      },
                    })
                  }
                  className="h-8 rounded-lg border border-border bg-background px-2"
                >
                  <option value="Viewer">
                    {host.translate('todo.permission_viewer', '只读成员')}
                  </option>
                </select>
              </label>
            )}
            {project.task_provider !== 'dingtalk_aitable' && (
              <label className="mt-4 flex items-center justify-between gap-3 text-sm">
                <span>{host.translate('todo.default_issue_security', '新任务默认可见范围')}</span>
                <select
                  data-testid="cloud-project-default-issue-security"
                  value={defaultIssueSecurity}
                  disabled={visibilityBusy}
                  onChange={event =>
                    void saveAccessSettings({
                      default_issue_security: event.target.value as 'open' | 'related',
                    })
                  }
                  className="h-8 rounded-lg border border-border bg-background px-2"
                >
                  <option value="open">
                    {host.translate('todo.issue_security_open', '项目可访问者可见')}
                  </option>
                  <option value="related">
                    {host.translate('todo.issue_security_related', '仅相关人员可见')}
                  </option>
                </select>
              </label>
            )}
          </section>
        )}

        <ProjectMembersSection
          project={project}
          host={host}
          controller={memberController}
          canManage={canManageMembers}
          membershipModeBusy={visibilityBusy}
          onMembershipModeChange={mode => void saveAccessSettings({ membership_mode: mode })}
          className={
            section === 'all' || section === 'members'
              ? embedded
                ? ''
                : 'border-t border-border py-6'
              : 'hidden'
          }
        />

        <details
          key={project.id}
          className={
            section === 'all' || section === 'overview' ? 'border-t border-border py-6' : 'hidden'
          }
          data-testid="cloud-project-manage-tags"
          onToggle={event => {
            if (event.currentTarget.open) setTagCatalogProjectId(project.id)
          }}
        >
          <summary
            className="cursor-pointer text-heading-md font-semibold"
            data-testid="cloud-project-manage-tags-toggle"
          >
            <h2 className="inline text-heading-md font-semibold">
              {host.translate('todo.project_tags', '标签')}
            </h2>
          </summary>
          {tagCatalogProjectId === project.id &&
            (tagLoadState?.projectId !== project.id || tagLoadState.loading ? (
              <p
                role="status"
                data-testid="cloud-project-manage-tags-loading"
                className="mt-3 text-sm text-text-muted"
              >
                {host.translate('common.loading', '正在加载…')}
              </p>
            ) : tagLoadState.error ? (
              <div
                role="alert"
                data-testid="cloud-project-manage-tags-error"
                className="mt-3 text-sm text-text-primary"
              >
                {tagLoadState.error}
                <button
                  type="button"
                  className="ml-2 underline"
                  data-testid="cloud-project-manage-tags-retry"
                  onClick={() => setTagLoadRevision(revision => revision + 1)}
                >
                  {host.translate('common.retry', '重试')}
                </button>
              </div>
            ) : (
              <ProjectTagsSection
                host={host}
                className="mt-3"
                allTags={allTags}
                renamingTag={renamingTag}
                renameValue={renameValue}
                tagComposerOpen={tagComposerOpen}
                newTag={newTag}
                tagBusy={tagBusy}
                setTagComposerOpen={setTagComposerOpen}
                setNewTag={setNewTag}
                setRenamingTag={setRenamingTag}
                setRenameValue={setRenameValue}
                createTag={createTag}
                renameTag={renameTag}
                deleteTag={deleteTag}
              />
            ))}
        </details>

        {(section === 'all' || section === providerSettingsSection) && (
          <ProjectProviderSection
            className=""
            render={renderProviderSettings}
            updateProject={values => updateProject(values, projectScope)}
            reportError={reportError}
          />
        )}

        {(section === 'all' || section === 'overview') && externalProvider && (
          <section className="border-t border-border py-6">
            <h2 className="text-heading-md font-semibold">
              {host.translate('todo.task_source', '任务来源')}
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              {host.translate('todo.task_source_description', '连接并同步外部 Issue 仓库。')}
            </p>
            <div className="mt-4 grid gap-2 rounded-xl bg-muted p-3 sm:grid-cols-[1fr_1fr_auto]">
              <label className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3">
                <GitBranch className="h-4 w-4 text-text-muted" />
                <input
                  data-testid="cloud-project-provider-manage-repository"
                  value={providerRepository}
                  onChange={event => {
                    setProviderRepository(event.target.value)
                    dirtyRef.current.providerRepository = true
                    setProviderSaved(false)
                  }}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  aria-label={host.translate('todo.repository_address', '仓库地址')}
                />
              </label>
              <label className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3">
                <LockKeyhole className="h-4 w-4 text-text-muted" />
                <input
                  data-testid="cloud-project-provider-manage-token"
                  type="password"
                  value={providerToken}
                  onChange={event => {
                    setProviderToken(event.target.value)
                    dirtyRef.current.providerToken = true
                    setProviderSaved(false)
                  }}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  placeholder={
                    project.provider_config.credential_configured
                      ? host.translate('todo.keep_existing_token', '留空保留当前令牌')
                      : host.translate('todo.access_token', '访问令牌')
                  }
                />
              </label>
              <button
                type="button"
                data-testid="cloud-project-provider-manage-save"
                disabled={providerBusy || !providerRepository.trim()}
                onClick={() => void saveProvider()}
                className="h-9 rounded-lg bg-text-primary px-3.5 text-sm text-background disabled:bg-text-primary disabled:text-background"
              >
                {providerSaved
                  ? host.translate('todo.saved', '已保存')
                  : host.translate('common.save', '保存')}
              </button>
            </div>
            {!project.provider_config.credential_configured && (
              <p className="mt-2 text-xs text-text-muted">
                {host.translate('todo.token_required', '需要配置令牌')}
              </p>
            )}
          </section>
        )}

        {(section === 'all' || section === 'board') && (
          <BoardLayoutEditor
            statuses={statuses}
            display={display}
            statusBusy={statusBusy}
            displayBusy={displayBusy}
            canEditStatuses={project.task_provider === 'local'}
            embedded={embedded}
            onStatusesChange={next => void saveStatuses(next)}
            onDisplayChange={(key, checked) => void saveDisplay(key, checked)}
            renderActionMenu={host.renderActionMenu}
            translate={(key, fallback, options) => host.translate(key, fallback ?? key, options)}
          />
        )}
        {error && <p className="pb-6 text-xs text-destructive">{error}</p>}
      </div>
    </div>
  )
}
