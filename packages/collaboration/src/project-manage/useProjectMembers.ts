// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { createAsyncResource, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { useDocumentEvent, useEscapeKey, useFocusRequest } from '../dom-events'
import { createMemberSearchResource, filterMemberSearchResults } from './memberSearch'
import type {
  ProjectManageApi,
  ProjectManageHost,
  ProjectManageItem,
  ProjectManageMember,
  ProjectManageProject,
  ProjectManageRole,
  ProjectManageUser,
} from './types'

type MemberApi<
  Project extends ProjectManageProject,
  Member extends ProjectManageMember,
  User extends ProjectManageUser,
> = Pick<
  ProjectManageApi<Project, Member, ProjectManageItem, User>,
  'getProject' | 'listMembers' | 'searchUsers' | 'addMember' | 'updateMember' | 'removeMember'
>

export function useProjectMembers<
  Project extends ProjectManageProject,
  Member extends ProjectManageMember,
  User extends ProjectManageUser,
>({
  api,
  host,
  projectId,
  currentUserId,
  onProjectUpdated,
  projectScopeRef,
  canManage,
  enabled = true,
  reportError,
  openMembersRequestId,
  onOpenMembersRequestConsumed,
}: {
  api: MemberApi<Project, Member, User>
  host: ProjectManageHost
  projectId: string
  currentUserId?: number
  onProjectUpdated?(project: Project): void
  projectScopeRef: RefObject<{ projectId: string }>
  canManage: boolean
  enabled?: boolean
  reportError(cause: unknown, fallback: string): void
  openMembersRequestId?: number
  onOpenMembersRequestConsumed?(requestId: number): void
}) {
  const resource = useMemo(
    () =>
      createAsyncResource<Member[]>(
        'project-members:' + projectId,
        () => api.listMembers(projectId),
        { refreshOnSubscribe: true }
      ),
    [api, projectId]
  )
  const snapshot = useSyncExternalStore(
    enabled ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    resource.getSnapshot
  )
  const members = snapshot.data ?? []
  const loading = snapshot.status === 'idle' || snapshot.status === 'loading'
  const loadError =
    snapshot.status === 'error'
      ? host.translate('todo.load_collaboration_data_failed', '加载协作数据失败')
      : null
  const [membersOpen, setMembersOpen] = useState(false)
  const [memberQuery, setMemberQuery] = useState('')
  const [memberRole, setMemberRole] = useState<Exclude<ProjectManageRole, 'Owner'>>('Developer')
  const [savingUserId, setSavingUserId] = useState<number | null>(null)
  const memberComposerRef = useRef<HTMLDivElement>(null)
  const memberSearchInputRef = useRef<HTMLInputElement>(null)
  const [renderedSource, setRenderedSource] = useState(resource)
  const [handledOpenRequestId, setHandledOpenRequestId] = useState<number | undefined>()

  if (renderedSource !== resource) {
    if (membersOpen) console.debug('[project-members] picker reset after member resource changed')
    setRenderedSource(resource)
    setHandledOpenRequestId(undefined)
    setMembersOpen(false)
    setMemberQuery('')
    setSavingUserId(null)
  }
  if (handledOpenRequestId !== openMembersRequestId) {
    setHandledOpenRequestId(openMembersRequestId)
    if (canManage && openMembersRequestId !== undefined) setMembersOpen(true)
  }

  const consumedRequest = useRef<{ resource: typeof resource; id: number } | null>(null)
  const memberPanelRef = useCallback(
    (node: HTMLElement | null) => {
      if (!node || openMembersRequestId === undefined) return
      const previous = consumedRequest.current
      if (previous?.resource === resource && previous.id === openMembersRequestId) return
      consumedRequest.current = { resource, id: openMembersRequestId }
      onOpenMembersRequestConsumed?.(openMembersRequestId)
    },
    [resource, openMembersRequestId, onOpenMembersRequestConsumed]
  )
  useDocumentEvent(
    'mousedown',
    event => {
      if (event.target instanceof Node && !memberComposerRef.current?.contains(event.target)) {
        console.debug('[project-members] picker closed by document mousedown')
        setMembersOpen(false)
      }
    },
    { enabled: membersOpen }
  )
  useEscapeKey(() => setMembersOpen(false), membersOpen, memberComposerRef)
  useFocusRequest(memberSearchInputRef, openMembersRequestId, { enabled: membersOpen })
  const query = memberQuery.trim()
  const searchResource = useMemo(
    () =>
      createMemberSearchResource<User>('project-member-search:' + projectId, query, value =>
        api.searchUsers(value)
      ),
    [api, projectId, query]
  )
  const searchSnapshot = useSyncExternalStore(
    enabled && canManage && membersOpen && query ? searchResource.subscribe : subscribeIdleResource,
    searchResource.getSnapshot,
    searchResource.getSnapshot
  )
  const memberResults = query ? filterMemberSearchResults(searchSnapshot.data ?? [], members) : []
  const memberSearchError =
    searchSnapshot.status === 'error'
      ? searchSnapshot.error instanceof Error
        ? searchSnapshot.error.message
        : host.translate('todo.search_members_failed', '搜索项目成员失败')
      : undefined

  async function refreshMemberState(
    scope: { projectId: string },
    options: { refreshProject?: boolean; reloadMembers?: boolean }
  ) {
    try {
      if (options.refreshProject) {
        const project = await api.getProject(scope.projectId)
        if (projectScopeRef.current !== scope) return
        onProjectUpdated?.(project)
        if (project.access_role !== 'Owner' && project.access_role !== 'Maintainer') return
      }
      if (options.reloadMembers) {
        const next = await api.listMembers(scope.projectId)
        if (projectScopeRef.current === scope) {
          resource.update(() => next)
        }
      }
    } catch (cause) {
      if (projectScopeRef.current === scope) {
        reportError(cause, host.translate('todo.load_project_failed', '加载项目失败'))
      }
    }
  }

  async function addMember(user: User) {
    if (!canManage || savingUserId !== null) return
    const scope = projectScopeRef.current
    setSavingUserId(user.id)
    try {
      const member = await api.addMember(scope.projectId, user.id, memberRole)
      if (projectScopeRef.current !== scope) return
      resource.update(current => [...(current ?? []), member])
      setMemberQuery('')
      host.trackCompleted('member_invite')
      await refreshMemberState(scope, { reloadMembers: true })
    } catch (cause) {
      if (projectScopeRef.current !== scope) return
      host.trackFailed()
      reportError(cause, host.translate('todo.add_member_failed', '添加成员失败'))
    } finally {
      if (projectScopeRef.current === scope) setSavingUserId(null)
    }
  }

  async function saveMember(
    member: Member,
    values: {
      role?: Exclude<ProjectManageRole, 'Owner'>
      capability_description?: string
    }
  ) {
    if (!canManage || savingUserId !== null) return
    const scope = projectScopeRef.current
    setSavingUserId(member.user_id)
    try {
      const next = await api.updateMember(scope.projectId, member.user_id, values)
      if (projectScopeRef.current !== scope) return
      resource.update(current =>
        (current ?? []).map(row => (row.user_id === next.user_id ? next : row))
      )
      if (values.role) host.trackCompleted('member_role_change')
      if (values.role && member.user_id === currentUserId) {
        await refreshMemberState(scope, { refreshProject: true })
      }
    } catch (cause) {
      if (projectScopeRef.current !== scope) return
      host.trackFailed()
      reportError(cause, host.translate('todo.update_member_failed', '更新成员失败'))
    } finally {
      if (projectScopeRef.current === scope) setSavingUserId(null)
    }
  }

  function updateMemberCapability(member: Member, value: string) {
    const capability = value.trim()
    if (capability === (member.capability_description ?? '')) return
    return saveMember(member, { capability_description: capability })
  }

  async function removeMember(member: Member) {
    if (!canManage || savingUserId !== null) return
    if (
      !host.confirm(
        member.inherited_role
          ? host.translate(
              'todo.reset_member_role_confirm',
              '移除“{{name}}”的项目角色，恢复分组角色？',
              { name: member.user_name }
            )
          : host.translate('todo.remove_member_confirm', '从项目中移除“{{name}}”？', {
              name: member.user_name,
            })
      )
    )
      return
    const scope = projectScopeRef.current
    setSavingUserId(member.user_id)
    try {
      await api.removeMember(scope.projectId, member.user_id)
      if (projectScopeRef.current !== scope) return
      host.trackCompleted('member_remove')
      await refreshMemberState(scope, {
        refreshProject: member.user_id === currentUserId,
        reloadMembers: true,
      })
    } catch (cause) {
      if (projectScopeRef.current !== scope) return
      host.trackFailed()
      reportError(cause, host.translate('todo.remove_member_failed', '移除成员失败'))
    } finally {
      if (projectScopeRef.current === scope) setSavingUserId(null)
    }
  }

  return {
    members,
    loading,
    loadError,
    retryLoad: resource.reload,
    memberPanelRef,
    memberSearchError,
    membersOpen,
    setMembersOpen,
    memberComposerRef,
    memberQuery,
    setMemberQuery,
    memberSearchInputRef,
    memberResults,
    memberRole,
    setMemberRole,
    savingUserId,
    addMember,
    removeMember,
    updateMemberCapability,
    updateMember: (member: Member, role: Exclude<ProjectManageRole, 'Owner'>) =>
      saveMember(member, { role }),
  }
}
