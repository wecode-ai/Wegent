import { Check, GitBranch, LockKeyhole, Pencil, Search, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AITableApi } from '@/api/aitable'
import type { DwsApi, DwsAuthStatus } from '@/api/dws'
import type {
  CloudLoopItem,
  CloudProject,
  CloudProjectMember,
  CloudUserSearchItem,
} from '@/api/deliveries'
import { ActionMenu } from '@/components/common/ActionMenu'
import { Tooltip } from '@/components/ui/tooltip'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { track } from '@/telemetry/client'
import { BoardLayoutEditor } from './BoardLayoutEditor'
import type { BoardCardDisplaySettings } from './CloudTodoBoardCard'
import { waitForDwsAuthentication } from './dwsAuth'
import {
  parseDingTalkAITableLink,
  repositoryAddress,
  repositoryProviderConfig,
} from './projectProviderConfig'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>
type BoardStatuses = NonNullable<CloudProject['board_config']>['statuses']

function configText(project: CloudProject, key: string): string {
  const value = (project.provider_config as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

function initialDisplay(
  project: CloudProject,
  display?: BoardCardDisplaySettings
): BoardCardDisplaySettings {
  return (
    display ?? {
      showAssignee: project.card_display?.show_assignee ?? true,
      showPriority: project.card_display?.show_priority ?? true,
      showTags: project.card_display?.show_tags ?? true,
      showDate: project.card_display?.show_date ?? true,
    }
  )
}

export function CloudProjectManageView({
  api,
  aitableApi,
  dwsApi,
  project,
  boardCardDisplay,
  onProjectUpdated,
}: {
  api: DeliveryApi
  aitableApi?: AITableApi
  dwsApi?: DwsApi
  project: CloudProject
  boardCardDisplay?: BoardCardDisplaySettings
  onProjectUpdated?: (project: CloudProject) => void
}) {
  const { t } = useTranslation('common')
  const [version, setVersion] = useState(project.version)
  const [error, setError] = useState<string | null>(null)
  const [members, setMembers] = useState<CloudProjectMember[]>([])
  const [items, setItems] = useState<CloudLoopItem[]>([])
  const [tags, setTags] = useState(project.tags ?? [])
  const [display, setDisplay] = useState(() => initialDisplay(project, boardCardDisplay))
  const [statuses, setStatuses] = useState<BoardStatuses>(project.board_config?.statuses ?? [])
  const [visibility, setVisibility] = useState(project.visibility ?? 'private')

  const [membersOpen, setMembersOpen] = useState(false)
  const [memberQuery, setMemberQuery] = useState('')
  const [memberResults, setMemberResults] = useState<CloudUserSearchItem[]>([])
  const [memberRole, setMemberRole] = useState<CloudProjectMember['role']>('Developer')
  const [savingUserId, setSavingUserId] = useState<number | null>(null)

  const [tagComposerOpen, setTagComposerOpen] = useState(false)
  const [newTag, setNewTag] = useState('')
  const [renamingTag, setRenamingTag] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [tagBusy, setTagBusy] = useState(false)
  const [displayBusy, setDisplayBusy] = useState(false)
  const [statusBusy, setStatusBusy] = useState(false)
  const [visibilityBusy, setVisibilityBusy] = useState(false)

  const externalProvider =
    project.task_provider === 'github' || project.task_provider === 'gitlab'
      ? project.task_provider
      : null
  const [providerRepository, setProviderRepository] = useState(() => repositoryAddress(project))
  const [providerToken, setProviderToken] = useState('')
  const [providerBusy, setProviderBusy] = useState(false)
  const [providerSaved, setProviderSaved] = useState(false)

  const isAITable = project.task_provider === 'dingtalk_aitable'
  const [aitableUrl, setAITableUrl] = useState(() => configText(project, 'source_url'))
  const [dwsStatus, setDwsStatus] = useState<DwsAuthStatus | null>(null)
  const [aitableBusy, setAITableBusy] = useState(false)
  const [aitableSaved, setAITableSaved] = useState(false)
  const aitableLink = parseDingTalkAITableLink(aitableUrl)

  useEffect(() => {
    let active = true
    void Promise.all([api.listCloudProjectMembers(project.id), api.listLoopItems(project.id)])
      .then(([nextMembers, response]) => {
        if (!active) return
        setMembers(nextMembers)
        setItems(response.items)
      })
      .catch(cause => active && setError(cause instanceof Error ? cause.message : '加载项目失败'))
    return () => {
      active = false
    }
  }, [api, project.id])

  useEffect(() => {
    if (!isAITable || !aitableApi) return
    void aitableApi
      .configureProject(project)
      .catch(cause => setError(cause instanceof Error ? cause.message : '加载字段失败'))
  }, [aitableApi, isAITable, project])

  useEffect(() => {
    if (!isAITable || !dwsApi) return
    void dwsApi
      .authStatus()
      .then(setDwsStatus)
      .catch(() => setDwsStatus(null))
  }, [dwsApi, isAITable])

  useEffect(() => {
    const query = memberQuery.trim()
    if (!query) return
    let active = true
    const timer = window.setTimeout(() => {
      void api.searchCloudProjectUsers(query).then(response => {
        if (!active) return
        const existing = new Set(members.map(member => member.user_id))
        setMemberResults(response.users.filter(user => !existing.has(user.id)))
      })
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [api, memberQuery, members])

  const allTags = useMemo(
    () => Array.from(new Set([...tags, ...items.flatMap(item => item.tags ?? [])])),
    [items, tags]
  )
  const visibleMemberResults = memberQuery.trim() ? memberResults : []
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) {
      for (const tag of item.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return counts
  }, [items])

  async function updateProject(values: Parameters<DeliveryApi['updateCloudProject']>[1]) {
    const updated = await api.updateCloudProject(project.id, { ...values, version })
    setVersion(updated.version)
    onProjectUpdated?.(updated)
    return updated
  }

  async function saveVisibility(next: 'private' | 'public') {
    if (visibilityBusy || visibility === next) return
    const previous = visibility
    setVisibility(next)
    setVisibilityBusy(true)
    try {
      const updated = await updateProject({ visibility: next, version })
      setVisibility(updated.visibility ?? next)
      track('feature_action_completed', { domain: 'project_space', action: 'update' })
    } catch (cause) {
      track('operation_failed', { operation: 'project_space_action' })
      setVisibility(previous)
      setError(cause instanceof Error ? cause.message : '更新项目权限失败')
    } finally {
      setVisibilityBusy(false)
    }
  }

  async function saveDisplay(key: keyof BoardCardDisplaySettings, checked: boolean) {
    if (displayBusy) return
    const previous = display
    const next = { ...display, [key]: checked }
    setDisplay(next)
    setDisplayBusy(true)
    try {
      await updateProject({
        version,
        card_display: {
          show_assignee: next.showAssignee,
          show_priority: next.showPriority,
          show_tags: next.showTags,
          show_date: next.showDate,
        },
      })
      track('feature_action_completed', { domain: 'project_space', action: 'update' })
    } catch (cause) {
      track('operation_failed', { operation: 'project_space_action' })
      setDisplay(previous)
      setError(cause instanceof Error ? cause.message : '保存卡片显示设置失败')
    } finally {
      setDisplayBusy(false)
    }
  }

  async function saveStatuses(next: BoardStatuses) {
    if (statusBusy) return
    const previous = statuses
    setStatuses(next)
    setStatusBusy(true)
    try {
      const updated = await updateProject({
        version,
        board_config: { group_by: project.board_config?.group_by ?? 'status', statuses: next },
      })
      setStatuses(updated.board_config?.statuses ?? next)
      track('feature_action_completed', { domain: 'project_space', action: 'update' })
    } catch (cause) {
      track('operation_failed', { operation: 'project_space_action' })
      setStatuses(previous)
      setError(cause instanceof Error ? cause.message : '保存状态设置失败')
    } finally {
      setStatusBusy(false)
    }
  }

  async function addMember(user: CloudUserSearchItem) {
    if (savingUserId !== null) return
    setSavingUserId(user.id)
    try {
      const member = await api.addCloudProjectMember(project.id, user.id, memberRole)
      setMembers(current => [...current, member])
      setMemberQuery('')
      track('feature_action_completed', { domain: 'project_space', action: 'member_invite' })
    } catch (cause) {
      track('operation_failed', { operation: 'project_space_action' })
      setError(cause instanceof Error ? cause.message : '添加成员失败')
    } finally {
      setSavingUserId(null)
    }
  }

  async function updateMember(
    member: CloudProjectMember,
    changes: { role?: CloudProjectMember['role']; description?: string }
  ) {
    try {
      const updated = await api.updateCloudProjectMember(
        project.id,
        member.user_id,
        changes.role,
        changes.description
      )
      setMembers(current =>
        current.map(item => (item.user_id === updated.user_id ? updated : item))
      )
      track('feature_action_completed', {
        domain: 'project_space',
        action: 'member_role_change',
      })
    } catch (cause) {
      track('operation_failed', { operation: 'project_space_action' })
      setError(cause instanceof Error ? cause.message : '更新成员失败')
    }
  }

  async function removeMember(member: CloudProjectMember) {
    if (!window.confirm(`从项目中移除“${member.user_name}”？`)) return
    try {
      await api.removeCloudProjectMember(project.id, member.user_id)
      setMembers(current => current.filter(item => item.user_id !== member.user_id))
      track('feature_action_completed', { domain: 'project_space', action: 'member_remove' })
    } catch (cause) {
      track('operation_failed', { operation: 'project_space_action' })
      setError(cause instanceof Error ? cause.message : '移除成员失败')
    }
  }

  async function persistTags(next: string[]) {
    const updated = await updateProject({ version, tags: next })
    setTags(updated.tags ?? next)
  }

  async function createTag() {
    const value = newTag.trim()
    if (!value || tagBusy) return
    setTagBusy(true)
    try {
      if (!allTags.includes(value)) await persistTags([...tags, value])
      setNewTag('')
      setTagComposerOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新建标签失败')
    } finally {
      setTagBusy(false)
    }
  }

  async function renameTag(source: string) {
    const target = renameValue.trim()
    setRenamingTag(null)
    if (!target || target === source || allTags.includes(target)) return
    setTagBusy(true)
    try {
      const changed = await Promise.all(
        items
          .filter(item => (item.tags ?? []).includes(source))
          .map(item =>
            api.updateLoopItem(item.id, {
              version: item.version,
              tags: (item.tags ?? []).map(tag => (tag === source ? target : tag)),
            })
          )
      )
      setItems(current => current.map(item => changed.find(next => next.id === item.id) ?? item))
      if (tags.includes(source)) await persistTags(tags.map(tag => (tag === source ? target : tag)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重命名标签失败')
    } finally {
      setTagBusy(false)
    }
  }

  async function deleteTag(tag: string) {
    const count = tagCounts.get(tag) ?? 0
    if (!window.confirm(`删除标签“${tag}”${count ? `，并从 ${count} 个任务上移除` : ''}？`)) return
    setTagBusy(true)
    try {
      const changed = await Promise.all(
        items
          .filter(item => (item.tags ?? []).includes(tag))
          .map(item =>
            api.updateLoopItem(item.id, {
              version: item.version,
              tags: (item.tags ?? []).filter(value => value !== tag),
            })
          )
      )
      setItems(current => current.map(item => changed.find(next => next.id === item.id) ?? item))
      if (tags.includes(tag)) await persistTags(tags.filter(value => value !== tag))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除标签失败')
    } finally {
      setTagBusy(false)
    }
  }

  async function saveProvider() {
    if (!externalProvider || providerBusy) return
    setProviderBusy(true)
    setProviderSaved(false)
    try {
      const updated = await updateProject({
        version,
        provider_config: {
          ...repositoryProviderConfig(providerRepository, externalProvider),
          ...(providerToken.trim() ? { token: providerToken.trim() } : {}),
        },
      })
      setProviderRepository(repositoryAddress(updated))
      setProviderToken('')
      setProviderSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存任务来源失败')
    } finally {
      setProviderBusy(false)
    }
  }

  async function saveAITable() {
    if (!aitableLink || aitableBusy) return
    setAITableBusy(true)
    setAITableSaved(false)
    try {
      await updateProject({
        version,
        provider_config: {
          base_id: aitableLink.baseId,
          table_id: aitableLink.tableId,
          source_url: aitableLink.url,
          ...(aitableLink.viewId ? { view_id: aitableLink.viewId } : {}),
        },
      })
      setAITableSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存钉钉多维表格配置失败')
    } finally {
      setAITableBusy(false)
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
      <div className="mx-auto max-w-[900px]">
        <header className="pb-7">
          <h1 className="text-heading-lg font-semibold">管理项目</h1>
          <p className="mt-1 text-sm text-text-muted">管理项目成员、标签和看板布局。</p>
        </header>

        <section className="border-t border-border py-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-heading-md font-semibold">项目成员</h2>
              <p className="mt-1 text-sm text-text-muted">成员可以访问项目任务和共享文件。</p>
            </div>
            <button
              type="button"
              data-testid="cloud-project-members-toggle"
              onClick={() => setMembersOpen(open => !open)}
              className="h-8 rounded-lg px-2.5 text-sm text-text-secondary hover:bg-muted"
            >
              {membersOpen ? '收起管理' : '管理成员'}
            </button>
          </div>

          {!membersOpen ? (
            <button
              type="button"
              onClick={() => setMembersOpen(true)}
              className="mt-4 flex h-12 w-full items-center rounded-xl bg-muted px-3 text-left hover:bg-muted/80"
            >
              <span>{members.length} 位成员</span>
              <span className="ml-auto flex -space-x-1.5">
                {members.slice(0, 3).map(member => (
                  <span
                    key={member.user_id}
                    className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-zinc-200 text-xs"
                  >
                    {member.user_name.slice(0, 1)}
                  </span>
                ))}
                {members.length > 3 && (
                  <span className="flex h-7 min-w-7 items-center justify-center rounded-full border-2 border-background bg-zinc-200 px-1 text-xs">
                    +{members.length - 3}
                  </span>
                )}
              </span>
            </button>
          ) : (
            <div className="mt-4 space-y-1 rounded-xl bg-muted p-1.5">
              {members.map(member => (
                <div
                  key={member.user_id}
                  data-testid={`cloud-project-member-${member.user_id}`}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-background/70"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-700 text-xs text-white">
                    {member.user_name.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{member.user_name}</span>
                    <span className="block truncate text-xs text-text-muted">{member.email}</span>
                    <textarea
                      data-testid={`cloud-project-member-description-${member.user_id}`}
                      value={member.description}
                      onChange={event => {
                        const description = event.target.value
                        setMembers(current =>
                          current.map(item =>
                            item.user_id === member.user_id ? { ...item, description } : item
                          )
                        )
                      }}
                      onBlur={event =>
                        void updateMember(member, { description: event.currentTarget.value.trim() })
                      }
                      placeholder="填写此成员在项目中的职责和能力"
                      className="mt-1 min-h-12 w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-xs leading-5 outline-none placeholder:text-text-tertiary focus:border-text-tertiary"
                    />
                  </span>
                  {member.role === 'Owner' ? (
                    <span className="text-xs text-text-secondary">Owner</span>
                  ) : (
                    <>
                      <select
                        data-testid={`cloud-project-member-role-${member.user_id}`}
                        value={member.role}
                        onChange={event =>
                          void updateMember(member, {
                            role: event.target.value as Exclude<
                              CloudProjectMember['role'],
                              'Owner'
                            >,
                          })
                        }
                        className="h-8 rounded-lg border border-border bg-background px-2 text-xs outline-none"
                      >
                        <option value="Maintainer">Maintainer</option>
                        <option value="Developer">Developer</option>
                        <option value="Reporter">Reporter</option>
                      </select>
                      <Tooltip
                        label={t('todo.remove_member', '移除 {{name}}', {
                          name: member.user_name,
                        })}
                        align="end"
                      >
                        <button
                          type="button"
                          data-testid={`cloud-project-member-remove-${member.user_id}`}
                          onClick={() => void removeMember(member)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-background hover:text-red-600"
                          aria-label={t('todo.remove_member', '移除 {{name}}', {
                            name: member.user_name,
                          })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </Tooltip>
                    </>
                  )}
                </div>
              ))}
              <div className="flex gap-2 rounded-lg bg-background/70 p-2">
                <label className="flex h-9 min-w-0 flex-1 items-center rounded-lg border border-border bg-background px-3">
                  <Search className="h-4 w-4 text-text-muted" />
                  <input
                    data-testid="cloud-member-search"
                    value={memberQuery}
                    onChange={event => setMemberQuery(event.target.value)}
                    className="ml-2 min-w-0 flex-1 bg-transparent text-sm outline-none"
                    placeholder="添加成员：搜索用户名或邮箱"
                  />
                </label>
                <select
                  data-testid="cloud-member-role"
                  value={memberRole}
                  onChange={event =>
                    setMemberRole(event.target.value as CloudProjectMember['role'])
                  }
                  className="h-9 rounded-lg border border-border bg-background px-2 text-sm outline-none"
                >
                  <option value="Maintainer">Maintainer</option>
                  <option value="Developer">Developer</option>
                  <option value="Reporter">Reporter</option>
                </select>
              </div>
              {visibleMemberResults.map(user => (
                <button
                  key={user.id}
                  type="button"
                  data-testid={`cloud-member-result-${user.id}`}
                  onClick={() => void addMember(user)}
                  className="flex h-10 w-full items-center rounded-lg px-3 text-left hover:bg-background"
                >
                  <span className="min-w-0 flex-1 truncate">{user.user_name}</span>
                  <span className="text-xs text-text-muted">
                    {savingUserId === user.id ? '添加中…' : '添加'}
                  </span>
                </button>
              ))}
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-background/70 p-1">
                {(['private', 'public'] as const).map(value => (
                  <button
                    key={value}
                    type="button"
                    data-testid={`cloud-project-manage-visibility-${value}`}
                    disabled={visibilityBusy}
                    onClick={() => void saveVisibility(value)}
                    className={cn(
                      'h-8 rounded-md text-xs',
                      visibility === value ? 'bg-background shadow-sm' : 'text-text-muted'
                    )}
                  >
                    {value === 'private' ? '私有项目' : '公开项目'}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="border-t border-border py-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-heading-md font-semibold">标签</h2>
              <p className="mt-1 text-sm text-text-muted">用于区分任务类型并筛选看板。</p>
            </div>
            <button
              type="button"
              onClick={() => setTagComposerOpen(open => !open)}
              className="h-8 rounded-lg px-2.5 text-sm text-text-secondary hover:bg-muted"
            >
              ＋ 新建标签
            </button>
          </div>
          {tagComposerOpen && (
            <div className="mt-3 flex gap-2">
              <input
                data-testid="cloud-project-tag-create-input"
                autoFocus
                value={newTag}
                onChange={event => setNewTag(event.target.value)}
                onKeyDown={event => event.key === 'Enter' && void createTag()}
                placeholder="输入标签名称"
                className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none"
              />
              <button
                type="button"
                data-testid="cloud-project-tag-create-confirm"
                disabled={!newTag.trim() || tagBusy}
                onClick={() => void createTag()}
                className="h-9 rounded-lg bg-black px-3.5 text-sm text-white disabled:bg-black disabled:text-white"
              >
                新建标签
              </button>
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {allTags.map(tag =>
              renamingTag === tag ? (
                <span key={tag} className="flex h-8 items-center gap-1 rounded-lg bg-muted px-1.5">
                  <input
                    data-testid={`cloud-project-tag-rename-input-${tag}`}
                    autoFocus
                    value={renameValue}
                    onChange={event => setRenameValue(event.target.value)}
                    onKeyDown={event => event.key === 'Enter' && void renameTag(tag)}
                    className="h-6 w-28 bg-transparent px-1 text-sm outline-none"
                  />
                  <Tooltip label={t('todo.confirm_rename', '确认重命名')}>
                    <button
                      type="button"
                      onClick={() => void renameTag(tag)}
                      aria-label={t('todo.confirm_rename', '确认重命名')}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                  <Tooltip label={t('todo.cancel_rename', '取消重命名')}>
                    <button
                      type="button"
                      onClick={() => setRenamingTag(null)}
                      aria-label={t('todo.cancel_rename', '取消重命名')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                </span>
              ) : (
                <span
                  key={tag}
                  data-testid={`cloud-project-tag-${tag}`}
                  className="group/tag relative flex h-8 items-center rounded-lg bg-muted px-2.5 text-sm text-text-secondary"
                >
                  <span className="transition-opacity group-hover/tag:opacity-0">{tag}</span>
                  <span className="absolute inset-0 opacity-0 transition-opacity group-hover/tag:opacity-100 focus-within:opacity-100">
                    <ActionMenu
                      ariaLabel={`${tag}标签菜单`}
                      testId={`cloud-project-tag-menu-${tag}`}
                      placement="bottom-end"
                      triggerClassName="flex h-8 w-full items-center justify-center rounded-lg text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
                      items={[
                        {
                          label: '重命名',
                          icon: Pencil,
                          onSelect: () => {
                            setRenamingTag(tag)
                            setRenameValue(tag)
                          },
                          testId: `cloud-project-tag-rename-${tag}`,
                        },
                        {
                          label: '删除标签',
                          icon: Trash2,
                          onSelect: () => deleteTag(tag),
                          testId: `cloud-project-tag-delete-${tag}`,
                          danger: true,
                        },
                      ]}
                    />
                  </span>
                </span>
              )
            )}
          </div>
        </section>

        {isAITable && (
          <section className="border-t border-border py-6" data-testid="aitable-provider-settings">
            <h2 className="text-heading-md font-semibold">钉钉多维表格</h2>
            <p className="mt-1 text-sm text-text-muted">配置看板使用的数据源。</p>
            <div className="mt-4 space-y-3 rounded-xl bg-muted p-3">
              <input
                data-testid="aitable-manage-url"
                value={aitableUrl}
                onChange={event => {
                  setAITableUrl(event.target.value)
                  setAITableSaved(false)
                }}
                className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none"
                placeholder="粘贴钉钉多维表格链接"
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">
                  {dwsStatus?.authenticated ? '钉钉已连接' : '尚未连接钉钉'}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    data-testid="aitable-dws-login"
                    disabled={!dwsApi || aitableBusy}
                    onClick={() => {
                      if (!dwsApi) return
                      setAITableBusy(true)
                      void dwsApi
                        .login()
                        .then(() => waitForDwsAuthentication(dwsApi))
                        .then(setDwsStatus)
                        .catch(cause =>
                          setError(cause instanceof Error ? cause.message : '连接钉钉失败')
                        )
                        .finally(() => setAITableBusy(false))
                    }}
                    className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm"
                  >
                    {aitableBusy ? '等待浏览器授权…' : '连接钉钉'}
                  </button>
                  <button
                    type="button"
                    data-testid="aitable-manage-save"
                    disabled={!aitableLink || aitableBusy}
                    onClick={() => void saveAITable()}
                    className="h-8 rounded-lg bg-text-primary px-2.5 text-sm text-background disabled:opacity-40"
                  >
                    {aitableSaved ? '已保存' : '保存连接'}
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {externalProvider && (
          <section className="border-t border-border py-6">
            <h2 className="text-heading-md font-semibold">任务来源</h2>
            <p className="mt-1 text-sm text-text-muted">连接并同步外部 Issue 仓库。</p>
            <div className="mt-4 grid gap-2 rounded-xl bg-muted p-3 sm:grid-cols-[1fr_1fr_auto]">
              <label className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3">
                <GitBranch className="h-4 w-4 text-text-muted" />
                <input
                  data-testid="cloud-project-provider-manage-repository"
                  value={providerRepository}
                  onChange={event => setProviderRepository(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  aria-label="仓库地址"
                />
              </label>
              <label className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3">
                <LockKeyhole className="h-4 w-4 text-text-muted" />
                <input
                  data-testid="cloud-project-provider-manage-token"
                  type="password"
                  value={providerToken}
                  onChange={event => setProviderToken(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  placeholder={
                    project.provider_config.credential_configured ? '留空保留当前令牌' : '访问令牌'
                  }
                />
              </label>
              <button
                type="button"
                data-testid="cloud-project-provider-manage-save"
                disabled={providerBusy || !providerRepository.trim()}
                onClick={() => void saveProvider()}
                className="h-9 rounded-lg bg-black px-3.5 text-sm text-white disabled:bg-black disabled:text-white"
              >
                {providerSaved ? '已保存' : '保存'}
              </button>
            </div>
            {!project.provider_config.credential_configured && (
              <p className="mt-2 text-xs text-text-muted">需要配置令牌</p>
            )}
          </section>
        )}

        <BoardLayoutEditor
          statuses={statuses}
          display={display}
          statusBusy={statusBusy}
          displayBusy={displayBusy}
          canEditStatuses={project.task_provider === 'local'}
          onStatusesChange={next => void saveStatuses(next)}
          onDisplayChange={(key, checked) => void saveDisplay(key, checked)}
        />
        {error && <p className="pb-6 text-xs text-destructive">{error}</p>}
      </div>
    </div>
  )
}
