import { useEffect, useState } from 'react'
import { Check, GitBranch, LockKeyhole, Pencil, Search, Tag, Trash2, X } from 'lucide-react'
import type { AITableApi } from '@/api/aitable'
import type { DwsApi, DwsAuthStatus } from '@/api/dws'
import type {
  CloudLoopItem,
  CloudProject,
  CloudProjectMember,
  CloudUserSearchItem,
} from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import {
  parseDingTalkAITableLink,
  repositoryAddress,
  repositoryProviderConfig,
} from './projectProviderConfig'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

const memberAvatarClasses = [
  'bg-gradient-to-br from-indigo-400 to-indigo-500',
  'bg-gradient-to-br from-emerald-400 to-emerald-500',
  'bg-gradient-to-br from-amber-400 to-amber-500',
]

function configText(project: CloudProject, key: string): string {
  const value = (project.provider_config as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

const DWS_AUTH_POLL_INTERVAL_MS = 750
const DWS_AUTH_POLL_ATTEMPTS = 160

async function waitForDwsAuthentication(dwsApi: DwsApi): Promise<DwsAuthStatus> {
  for (let attempt = 0; attempt < DWS_AUTH_POLL_ATTEMPTS; attempt += 1) {
    await new Promise(resolve => window.setTimeout(resolve, DWS_AUTH_POLL_INTERVAL_MS))
    const status = await dwsApi.authStatus()
    if (status.authenticated && status.token_valid !== false) return status
  }
  throw new Error('钉钉授权等待超时，请重试。')
}

export function CloudProjectManageView({
  api,
  aitableApi,
  dwsApi,
  project,
  onProjectUpdated,
}: {
  api: DeliveryApi
  aitableApi?: AITableApi
  dwsApi?: DwsApi
  project: CloudProject
  onProjectUpdated?: (project: CloudProject) => void
}) {
  const { t } = useTranslation('common')
  const [members, setMembers] = useState<CloudProjectMember[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CloudUserSearchItem[]>([])
  const [role, setRole] = useState<CloudProjectMember['role']>('Developer')
  const [savingUserId, setSavingUserId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<CloudLoopItem[]>([])
  const [registryTags, setRegistryTags] = useState<string[]>(project.tags ?? [])
  const [projectVersion, setProjectVersion] = useState(project.version)
  const [visibility, setVisibility] = useState<'private' | 'public'>(
    project.visibility ?? 'private'
  )
  const [visibilityBusy, setVisibilityBusy] = useState(false)
  const [newTag, setNewTag] = useState('')
  const [renamingTag, setRenamingTag] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [tagBusy, setTagBusy] = useState(false)
  const externalProvider =
    project.task_provider === 'github' || project.task_provider === 'gitlab'
      ? project.task_provider
      : null
  const [providerRepository, setProviderRepository] = useState(() => repositoryAddress(project))
  const [providerToken, setProviderToken] = useState('')
  const [providerBusy, setProviderBusy] = useState(false)
  const [providerSaved, setProviderSaved] = useState(false)
  const isAITableProvider = project.task_provider === 'dingtalk_aitable'
  const [aitableUrl, setAITableUrl] = useState(() => configText(project, 'source_url'))
  const [dwsStatus, setDwsStatus] = useState<DwsAuthStatus | null>(null)
  const [aitableBusy, setAitableBusy] = useState(false)
  const [aitableSaved, setAITableSaved] = useState(false)
  const aitableLink = parseDingTalkAITableLink(aitableUrl)

  useEffect(() => {
    let active = true
    void api
      .listCloudProjectMembers(project.id)
      .then(value => active && setMembers(value))
      .catch(cause => active && setError(cause instanceof Error ? cause.message : '加载成员失败'))
    void api
      .listLoopItems(project.id)
      .then(response => active && setItems(response.items))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [api, project.id])

  useEffect(() => {
    if (!isAITableProvider || !aitableApi) return
    let active = true
    void aitableApi
      .configureProject(project)
      .then(() => undefined)
      .catch(cause => active && setError(cause instanceof Error ? cause.message : '加载字段失败'))
    return () => {
      active = false
    }
  }, [aitableApi, isAITableProvider, project])

  useEffect(() => {
    if (!isAITableProvider || !dwsApi) return
    void dwsApi
      .authStatus()
      .then(setDwsStatus)
      .catch(() => setDwsStatus(null))
  }, [dwsApi, isAITableProvider])

  // Tags shown in the manager: project registry plus tags already on items.
  const allTags = Array.from(
    new Set([...registryTags, ...items.flatMap(item => item.tags ?? [])])
  ).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const tagCounts = new Map<string, number>()
  for (const item of items) {
    for (const tag of item.tags ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
    }
  }

  async function persistRegistry(tags: string[]) {
    const updated = await api.updateCloudProject(project.id, { version: projectVersion, tags })
    setRegistryTags(updated.tags ?? [])
    setProjectVersion(updated.version)
    onProjectUpdated?.(updated)
  }

  async function saveVisibility(nextVisibility: 'private' | 'public') {
    if (visibilityBusy || nextVisibility === visibility) return
    setVisibilityBusy(true)
    setError(null)
    try {
      const updated = await api.updateCloudProject(project.id, {
        version: projectVersion,
        visibility: nextVisibility,
      })
      setVisibility(updated.visibility ?? nextVisibility)
      setProjectVersion(updated.version)
      onProjectUpdated?.(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.project_visibility_update_failed'))
    } finally {
      setVisibilityBusy(false)
    }
  }

  async function saveProviderConfig() {
    if (!externalProvider || providerBusy) return
    setProviderBusy(true)
    setProviderSaved(false)
    setError(null)
    try {
      const updated = await api.updateCloudProject(project.id, {
        version: projectVersion,
        provider_config: {
          ...repositoryProviderConfig(providerRepository, externalProvider),
          ...(providerToken.trim() ? { token: providerToken.trim() } : {}),
        },
      })
      setProjectVersion(updated.version)
      setProviderRepository(repositoryAddress(updated))
      setProviderToken('')
      setProviderSaved(true)
      onProjectUpdated?.(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存任务来源失败')
    } finally {
      setProviderBusy(false)
    }
  }

  async function saveAITableConfig() {
    if (!isAITableProvider || aitableBusy) return
    setAitableBusy(true)
    setAITableSaved(false)
    setError(null)
    try {
      const updated = await api.updateCloudProject(project.id, {
        version: projectVersion,
        provider_config: {
          base_id: aitableLink!.baseId,
          table_id: aitableLink!.tableId,
          source_url: aitableLink!.url,
          ...(aitableLink!.viewId ? { view_id: aitableLink!.viewId } : {}),
        },
      })
      setProjectVersion(updated.version)
      setAITableSaved(true)
      onProjectUpdated?.(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存钉钉多维表格配置失败')
    } finally {
      setAitableBusy(false)
    }
  }

  async function createTag() {
    const tag = newTag.trim()
    if (!tag || tagBusy) return
    setTagBusy(true)
    setError(null)
    try {
      if (!allTags.includes(tag)) await persistRegistry([...registryTags, tag])
      setNewTag('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新建标签失败')
    } finally {
      setTagBusy(false)
    }
  }

  async function renameTag(oldTag: string) {
    const nextTag = renameValue.trim()
    setRenamingTag(null)
    if (!nextTag || nextTag === oldTag || tagBusy) return
    if (allTags.includes(nextTag)) {
      setError(`标签“${nextTag}”已存在`)
      return
    }
    setTagBusy(true)
    setError(null)
    try {
      const affected = items.filter(item => (item.tags ?? []).includes(oldTag))
      const renamed = await Promise.all(
        affected.map(item =>
          api.updateLoopItem(item.id, {
            version: item.version,
            tags: (item.tags ?? []).map(tag => (tag === oldTag ? nextTag : tag)),
          })
        )
      )
      setItems(current => current.map(item => renamed.find(entry => entry.id === item.id) ?? item))
      if (registryTags.includes(oldTag)) {
        await persistRegistry(registryTags.map(tag => (tag === oldTag ? nextTag : tag)))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重命名标签失败')
    } finally {
      setTagBusy(false)
    }
  }

  async function deleteTag(target: string) {
    const count = tagCounts.get(target) ?? 0
    const hint = count > 0 ? `，并从 ${count} 个任务上移除` : ''
    if (!window.confirm(`删除标签“${target}”${hint}？`) || tagBusy) return
    setTagBusy(true)
    setError(null)
    try {
      const affected = items.filter(item => (item.tags ?? []).includes(target))
      const stripped = await Promise.all(
        affected.map(item =>
          api.updateLoopItem(item.id, {
            version: item.version,
            tags: (item.tags ?? []).filter(tag => tag !== target),
          })
        )
      )
      setItems(current => current.map(item => stripped.find(entry => entry.id === item.id) ?? item))
      if (registryTags.includes(target)) {
        await persistRegistry(registryTags.filter(tag => tag !== target))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除标签失败')
    } finally {
      setTagBusy(false)
    }
  }

  useEffect(() => {
    let active = true
    const normalized = query.trim()
    if (!normalized) {
      return () => {
        active = false
      }
    }
    const timer = window.setTimeout(() => {
      void api
        .searchCloudProjectUsers(normalized)
        .then(response => {
          if (!active) return
          const existing = new Set(members.map(member => member.user_id))
          setResults(response.users.filter(user => !existing.has(user.id)))
        })
        .catch(cause => active && setError(cause instanceof Error ? cause.message : '搜索失败'))
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [api, members, query])
  const visibleResults = query.trim() ? results : []

  async function addMember(user: CloudUserSearchItem) {
    if (savingUserId !== null) return
    setSavingUserId(user.id)
    setError(null)
    try {
      const member = await api.addCloudProjectMember(project.id, user.id, role)
      setMembers(current => [...current, member])
      setResults(current => current.filter(result => result.id !== user.id))
      setQuery('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '添加成员失败')
    } finally {
      setSavingUserId(null)
    }
  }

  async function updateMember(
    member: CloudProjectMember,
    nextRole: Exclude<CloudProjectMember['role'], 'Owner'>
  ) {
    setError(null)
    try {
      const updated = await api.updateCloudProjectMember(project.id, member.user_id, nextRole)
      setMembers(current =>
        current.map(existing => (existing.user_id === updated.user_id ? updated : existing))
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更新成员失败')
    }
  }

  async function removeMember(member: CloudProjectMember) {
    if (!window.confirm(`从项目中移除“${member.user_name}”？`)) return
    setError(null)
    try {
      await api.removeCloudProjectMember(project.id, member.user_id)
      setMembers(current => current.filter(existing => existing.user_id !== member.user_id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '移除成员失败')
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
      <div className="mx-auto max-w-[960px]">
        <h2 className="text-heading-md font-semibold">{t('todo.project_visibility')}</h2>
        <p className="mt-1 text-sm text-text-muted">
          {t('todo.project_visibility_manage_description')}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          {(
            [
              [
                'private',
                t('todo.project_visibility_private'),
                t('todo.project_visibility_private_manage_description'),
              ],
              [
                'public',
                t('todo.project_visibility_public'),
                t('todo.project_visibility_public_manage_description'),
              ],
            ] as const
          ).map(([value, label, detail]) => (
            <button
              key={value}
              type="button"
              data-testid={`cloud-project-manage-visibility-${value}`}
              disabled={visibilityBusy}
              aria-pressed={visibility === value}
              onClick={() => void saveVisibility(value)}
              className={cn(
                'rounded-xl border px-4 py-3 text-left transition disabled:opacity-60',
                visibility === value
                  ? 'border-text-primary bg-muted/70 ring-1 ring-text-primary/10'
                  : 'border-border hover:bg-muted/40'
              )}
            >
              <span className="block text-sm font-medium">{label}</span>
              <span className="mt-1 block text-xs leading-4 text-text-muted">{detail}</span>
            </button>
          ))}
        </div>

        <div className="mt-10 border-t border-border pt-8">
          <h2 className="text-heading-md font-semibold">项目成员</h2>
          <p className="mt-1 text-sm text-text-muted">
            成员只能访问被授权的云项目、任务、共享文件和交付。
          </p>

          <div className="mt-6 overflow-hidden rounded-xl border border-border bg-background shadow-sm">
            {members.map((member, index) => (
              <div
                key={member.user_id}
                className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0"
                data-testid={`cloud-project-member-${member.user_id}`}
              >
                <span
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-background',
                    memberAvatarClasses[index % memberAvatarClasses.length]
                  )}
                >
                  {member.user_name.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{member.user_name}</span>
                  <span className="block truncate text-xs text-text-muted">{member.email}</span>
                </span>
                {member.role === 'Owner' ? (
                  <span className="w-24 text-xs text-text-secondary">Owner</span>
                ) : (
                  <>
                    <select
                      data-testid={`cloud-project-member-role-${member.user_id}`}
                      value={member.role}
                      onChange={event =>
                        void updateMember(
                          member,
                          event.target.value as Exclude<CloudProjectMember['role'], 'Owner'>
                        )
                      }
                      className="h-8 w-24 rounded-lg border border-border bg-background px-1.5 text-xs outline-none focus:border-text-muted"
                    >
                      <option value="Maintainer">Maintainer</option>
                      <option value="Developer">Developer</option>
                      <option value="Reporter">Reporter</option>
                    </select>
                    <button
                      type="button"
                      data-testid={`cloud-project-member-remove-${member.user_id}`}
                      onClick={() => void removeMember(member)}
                      className="ml-1 flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-red-600"
                      aria-label={`移除 ${member.user_name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>

          <div className="mt-8">
            <h3 className="text-sm font-semibold">添加成员</h3>
            <div className="mt-3 flex gap-2">
              <label className="flex h-9 min-w-0 flex-1 items-center rounded-lg border border-border bg-background px-3 focus-within:border-text-muted">
                <Search className="h-4 w-4 text-text-muted" />
                <input
                  data-testid="cloud-member-search"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  className="ml-2 min-w-0 flex-1 bg-transparent text-sm outline-none"
                  placeholder="搜索用户名或邮箱"
                />
              </label>
              <select
                data-testid="cloud-member-role"
                value={role}
                onChange={event => setRole(event.target.value as CloudProjectMember['role'])}
                className="h-9 rounded-lg border border-border bg-background px-2 text-sm outline-none focus:border-text-muted"
              >
                <option value="Maintainer">Maintainer</option>
                <option value="Developer">Developer</option>
                <option value="Reporter">Reporter</option>
              </select>
            </div>
            {visibleResults.length > 0 && (
              <div className="mt-2 overflow-hidden rounded-xl border border-border bg-background shadow-sm">
                {visibleResults.map(user => (
                  <button
                    key={user.id}
                    type="button"
                    data-testid={`cloud-member-result-${user.id}`}
                    disabled={savingUserId !== null}
                    onClick={() => void addMember(user)}
                    className="flex w-full items-center border-t border-border px-4 py-2.5 text-left transition first:border-t-0 hover:bg-hover disabled:opacity-50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{user.user_name}</span>
                      <span className="block truncate text-xs text-text-muted">{user.email}</span>
                    </span>
                    <span className="rounded-md bg-text-primary px-2 py-1 text-xs text-background">
                      {savingUserId === user.id ? '添加中…' : '添加'}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          </div>
        </div>

        <div className="mt-10">
          <h2 className="text-heading-md font-semibold">标签管理</h2>
          <p className="mt-1 text-sm text-text-muted">
            标签用于区分任务类型（如产品需求、研发需求），新建后可在任务上选择，看板支持按标签筛选。
          </p>

          <div className="mt-4 flex gap-2">
            <input
              data-testid="cloud-project-tag-create-input"
              value={newTag}
              onChange={event => setNewTag(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void createTag()
                }
              }}
              placeholder="输入标签名称，如 产品需求"
              maxLength={32}
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-text-muted"
            />
            <button
              type="button"
              data-testid="cloud-project-tag-create-confirm"
              disabled={!newTag.trim() || tagBusy}
              onClick={() => void createTag()}
              className="h-9 rounded-lg bg-black px-3.5 text-sm font-medium text-white transition hover:bg-black/90 disabled:cursor-not-allowed disabled:bg-black disabled:text-white"
            >
              新建标签
            </button>
          </div>

          <div className="mt-4 overflow-hidden rounded-xl border border-border bg-background shadow-sm">
            {allTags.length === 0 && (
              <p className="px-4 py-6 text-center text-xs text-text-muted">
                还没有标签，先新建一个吧
              </p>
            )}
            {allTags.map(tag => (
              <div
                key={tag}
                data-testid={`cloud-project-tag-${tag}`}
                className="flex items-center gap-3 border-t border-border px-4 py-2.5 first:border-t-0"
              >
                <Tag className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                {renamingTag === tag ? (
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      data-testid={`cloud-project-tag-rename-input-${tag}`}
                      autoFocus
                      value={renameValue}
                      onChange={event => setRenameValue(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void renameTag(tag)
                        }
                        if (event.key === 'Escape') setRenamingTag(null)
                      }}
                      maxLength={32}
                      className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-text-muted"
                    />
                    <button
                      type="button"
                      aria-label="确认重命名"
                      onClick={() => void renameTag(tag)}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label="取消重命名"
                      onClick={() => setRenamingTag(null)}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{tag}</span>
                    <span className="shrink-0 text-xs text-text-muted">
                      {tagCounts.get(tag) ?? 0} 个任务
                    </span>
                    <button
                      type="button"
                      data-testid={`cloud-project-tag-rename-${tag}`}
                      aria-label={`重命名标签 ${tag}`}
                      disabled={tagBusy}
                      onClick={() => {
                        setRenamingTag(tag)
                        setRenameValue(tag)
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary disabled:opacity-50"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      data-testid={`cloud-project-tag-delete-${tag}`}
                      aria-label={`删除标签 ${tag}`}
                      disabled={tagBusy}
                      onClick={() => void deleteTag(tag)}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-red-600 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>

        {isAITableProvider && (
          <section className="mt-10" data-testid="aitable-provider-settings">
            <h2 className="text-heading-md font-semibold">钉钉多维表格</h2>
            <p className="mt-1 text-sm text-text-muted">
              配置钉钉数据源。看板与数据视图会直接读取表格字段，无需额外映射。
            </p>
            <div className="mt-4 space-y-4 rounded-xl border border-border bg-background p-4 shadow-sm">
              <label className="block text-sm font-medium">
                多维表格链接
                <input
                  data-testid="aitable-manage-url"
                  value={aitableUrl}
                  onChange={event => {
                    setAITableUrl(event.target.value)
                    setAITableSaved(false)
                  }}
                  className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm font-normal outline-none focus:border-focus"
                  placeholder="粘贴 alidocs.dingtalk.com 多维表格链接"
                />
                {aitableUrl && !aitableLink ? (
                  <span className="mt-1.5 block text-xs font-normal text-destructive">
                    无法识别这个链接，请复制完整浏览器地址。
                  </span>
                ) : null}
              </label>
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium">
                    {dwsStatus?.authenticated
                      ? `已连接${dwsStatus.corp_name ? ` · ${dwsStatus.corp_name}` : ''}`
                      : '尚未连接钉钉'}
                  </p>
                  <p className="mt-0.5 text-xs text-text-muted">
                    Wework 项目角色与钉钉表格权限会同时生效。
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="aitable-dws-login"
                  disabled={!dwsApi || aitableBusy}
                  onClick={() => {
                    if (!dwsApi) return
                    setAitableBusy(true)
                    setError(null)
                    void dwsApi
                      .login()
                      .then(() => waitForDwsAuthentication(dwsApi))
                      .then(setDwsStatus)
                      .catch(cause =>
                        setError(cause instanceof Error ? cause.message : '连接钉钉失败')
                      )
                      .finally(() => setAitableBusy(false))
                  }}
                  className="h-9 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted disabled:opacity-40"
                >
                  {aitableBusy
                    ? t('todo.dws_waiting_for_authorization')
                    : dwsStatus?.authenticated
                      ? '重新连接'
                      : '连接钉钉'}
                </button>
              </div>
              <div className="flex items-center justify-end gap-3">
                {aitableSaved && <span className="text-xs text-emerald-600">已保存</span>}
                <button
                  type="button"
                  data-testid="aitable-manage-save"
                  disabled={aitableBusy || !aitableLink}
                  onClick={() => void saveAITableConfig()}
                  className="h-9 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-80 disabled:opacity-40"
                >
                  {aitableBusy ? '保存中…' : '保存连接'}
                </button>
              </div>
            </div>
          </section>
        )}

        {externalProvider && (
          <section className="mt-10">
            <h2 className="text-heading-md font-semibold">任务来源</h2>
            <p className="mt-1 text-sm text-text-muted">
              云端保存项目和访问令牌，本地 Executor 直接读取和更新{' '}
              {externalProvider === 'github' ? 'GitHub' : 'GitLab'} Issues。
            </p>
            <div className="mt-4 rounded-xl border border-border bg-background p-4 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-medium">
                <GitBranch className="h-4 w-4 text-text-secondary" />
                {externalProvider === 'github' ? 'GitHub' : 'GitLab'}
                <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-normal text-text-muted">
                  {project.provider_config.credential_configured ? '令牌已配置' : '需要配置令牌'}
                </span>
              </div>
              <label className="mt-4 block text-sm font-medium">
                仓库地址
                <input
                  data-testid="cloud-project-provider-manage-repository"
                  value={providerRepository}
                  onChange={event => {
                    setProviderRepository(event.target.value)
                    setProviderSaved(false)
                  }}
                  className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm font-normal outline-none focus:border-text-muted"
                />
              </label>
              <label className="mt-4 block text-sm font-medium">
                访问令牌
                <span className="ml-1 text-xs font-normal text-text-muted">
                  {project.provider_config.credential_configured
                    ? '留空则保留当前令牌'
                    : '当前项目尚未配置'}
                </span>
                <div className="relative mt-2">
                  <LockKeyhole className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-text-muted" />
                  <input
                    data-testid="cloud-project-provider-manage-token"
                    type="password"
                    autoComplete="new-password"
                    value={providerToken}
                    onChange={event => {
                      setProviderToken(event.target.value)
                      setProviderSaved(false)
                    }}
                    className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm font-normal outline-none focus:border-text-muted"
                    placeholder="输入新令牌"
                  />
                </div>
              </label>
              <div className="mt-4 flex items-center justify-end gap-3">
                {providerSaved && <span className="text-xs text-emerald-600">已保存</span>}
                <button
                  type="button"
                  data-testid="cloud-project-provider-manage-save"
                  disabled={
                    providerBusy ||
                    !providerRepository.trim() ||
                    (!project.provider_config.credential_configured && !providerToken.trim())
                  }
                  onClick={() => void saveProviderConfig()}
                  className="h-9 rounded-lg bg-black px-3.5 text-sm font-medium text-white transition hover:bg-black/90 disabled:cursor-not-allowed disabled:bg-black disabled:text-white"
                >
                  {providerBusy ? '保存中…' : '保存任务来源'}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
