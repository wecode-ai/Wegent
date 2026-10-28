// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState, type RefObject } from 'react'
import { clearMemberResultsForEmptyQuery, runActiveMemberSearch } from './memberSearch'
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
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadRevision, setLoadRevision] = useState(0)
  const [membersOpen, setMembersOpen] = useState(false)
  const [memberQuery, setMemberQuery] = useState('')
  const [memberResults, setMemberResults] = useState<User[]>([])
  const [memberRole, setMemberRole] = useState<Exclude<ProjectManageRole, 'Owner'>>('Developer')
  const [savingUserId, setSavingUserId] = useState<number | null>(null)
  const memberComposerRef = useRef<HTMLDivElement>(null)
  const memberSearchInputRef = useRef<HTMLInputElement>(null)
  const [renderedProjectId, setRenderedProjectId] = useState(projectId)
  const [handledOpenRequestId, setHandledOpenRequestId] = useState<number | undefined>()

  if (renderedProjectId !== projectId) {
    setRenderedProjectId(projectId)
    setMembers([])
    setLoadError(null)
    setLoading(true)
    setMembersOpen(false)
    setMemberQuery('')
    setMemberResults([])
    setSavingUserId(null)
  }
  if (handledOpenRequestId !== openMembersRequestId) {
    setHandledOpenRequestId(openMembersRequestId)
    if (canManage && openMembersRequestId !== undefined) setMembersOpen(true)
  }

  useEffect(() => {
    if (!enabled) return
    let active = true
    setLoadError(null)
    setLoading(true)
    void api.listMembers(projectId).then(
      next => {
        if (!active) return
        setMembers(next)
        setLoading(false)
      },
      () => {
        if (!active) return
        setLoading(false)
        setLoadError(host.translate('todo.load_collaboration_data_failed', '加载协作数据失败'))
      }
    )
    return () => {
      active = false
    }
  }, [api, enabled, host, projectId, loadRevision])

  useEffect(() => {
    if (!membersOpen || typeof document === 'undefined') return
    const close = (event: MouseEvent) => {
      if (event.target instanceof Node && !memberComposerRef.current?.contains(event.target)) {
        setMembersOpen(false)
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMembersOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [membersOpen])

  useEffect(() => {
    if (openMembersRequestId === undefined) return
    onOpenMembersRequestConsumed?.(openMembersRequestId)
  }, [openMembersRequestId, onOpenMembersRequestConsumed, canManage])

  useEffect(() => {
    if (!membersOpen) return
    memberSearchInputRef.current?.focus()
  }, [membersOpen, openMembersRequestId])

  useEffect(() => {
    const query = memberQuery.trim()
    if (!query) return
    let active = true
    const timer = window.setTimeout(() => {
      void runActiveMemberSearch({
        query,
        existingUserIds: new Set(members.map(member => member.user_id)),
        search: api.searchUsers,
        userId: user => user.id,
        isActive: () => active,
        onResults: setMemberResults,
        onError: cause =>
          reportError(cause, host.translate('todo.search_members_failed', '搜索项目成员失败')),
      })
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [api, host, memberQuery, members, reportError])

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
        if (projectScopeRef.current === scope) setMembers(next)
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
      setMembers(current => [...current, member])
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
      setMembers(current => current.map(row => (row.user_id === next.user_id ? next : row)))
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
              '移除“{{name}}”的项目角色，恢复空间角色？',
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
    retryLoad: () => setLoadRevision(value => value + 1),
    membersOpen,
    setMembersOpen,
    memberComposerRef,
    memberQuery,
    setMemberQuery: (query: string) => {
      setMemberQuery(query)
      clearMemberResultsForEmptyQuery(query, setMemberResults)
    },
    memberSearchInputRef,
    memberResults: memberQuery.trim() ? memberResults : [],
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
