import { Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PluginShareGroupSearchItem, PluginShareUserSearchItem } from '@/api/plugins'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginAccessTarget } from '@/types/api'

export type PluginPublishVisibility = 'public' | 'workspace' | 'personal'

export interface PluginPublishRequest {
  visibility: PluginPublishVisibility
  targets: PluginAccessTarget[]
  allowCopy: boolean
}

interface PluginPublishDialogProps {
  pluginName: string
  canPublish: boolean
  canSharePersonal: boolean
  publishing: boolean
  error?: string | null
  onClose: () => void
  onPublish: (request: PluginPublishRequest) => void
  searchUsers: (query: string) => Promise<PluginShareUserSearchItem[]>
  searchGroups: (query: string) => Promise<PluginShareGroupSearchItem[]>
}

export function PluginPublishDialog({
  pluginName,
  canPublish,
  canSharePersonal,
  publishing,
  error,
  onClose,
  onPublish,
  searchUsers,
  searchGroups,
}: PluginPublishDialogProps) {
  const { t } = useTranslation('common')
  const defaultVisibility: PluginPublishVisibility = canSharePersonal
    ? 'personal'
    : canPublish
      ? 'workspace'
      : 'personal'
  const [visibility, setVisibility] = useState<PluginPublishVisibility>(defaultVisibility)
  const [targets, setTargets] = useState<PluginAccessTarget[]>([])
  const [allowCopy, setAllowCopy] = useState(false)
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState<PluginShareUserSearchItem[]>([])
  const [groups, setGroups] = useState<PluginShareGroupSearchItem[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const normalized = query.trim()
    if (!normalized || visibility !== 'personal') {
      return
    }
    let current = true
    queueMicrotask(() => {
      if (current) setSearching(true)
    })
    Promise.all([searchUsers(normalized), searchGroups(normalized)])
      .then(([nextUsers, nextGroups]) => {
        if (!current) return
        setUsers(nextUsers)
        setGroups(nextGroups)
      })
      .finally(() => {
        if (current) setSearching(false)
      })
    return () => {
      current = false
    }
  }, [query, visibility, searchGroups, searchUsers])

  const addTarget = (target: PluginAccessTarget) => {
    setTargets(current =>
      current.some(
        item => item.entityType === target.entityType && item.entityId === target.entityId
      )
        ? current
        : [...current, target]
    )
    setQuery('')
  }

  const selectVisibility = (next: PluginPublishVisibility) => {
    if (next !== 'personal' && !canPublish) return
    if (next === 'personal' && !canSharePersonal) return
    setVisibility(next)
    if (next !== 'personal') {
      setTargets([])
      setAllowCopy(false)
      setQuery('')
    }
  }

  const confirmDisabled =
    publishing ||
    (visibility === 'personal' && !canSharePersonal) ||
    (visibility !== 'personal' && !canPublish)

  const hint =
    visibility === 'personal'
      ? t(
          'workbench.plugins_publish_hint_personal',
          '指定成员或部门可用；扫描通过后立即生效，无需人工审核。'
        )
      : visibility === 'workspace'
        ? t(
            'workbench.plugins_publish_hint_workspace',
            '组织内可见；扫描通过后进入审核，通过后上架。'
          )
        : t(
            'workbench.plugins_publish_hint_public',
            '全部用户可见；扫描通过后进入审核，通过后上架。'
          )

  return (
    <div className="plugin-dialog-overlay fixed inset-0 z-modal flex items-end justify-center p-0 sm:items-center sm:p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-publish-title"
        data-testid="plugin-publish-dialog"
        className="plugin-dialog-surface w-full max-w-lg rounded-b-none p-5 sm:rounded-b-[20px]"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 id="plugin-publish-title" className="heading-small text-text-primary">
              {t('workbench.plugins_publish_title', '发布插件')}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">{pluginName}</p>
          </div>
          <button
            type="button"
            data-testid="plugin-publish-close"
            aria-label={t('common.close', '关闭')}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-text-muted hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20 sm:h-8 sm:w-8"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="mt-5 grid grid-cols-3 gap-2 rounded-xl bg-surface p-1">
          {(
            [
              ['personal', 'workbench.plugins_publish_scope_people', '人', canSharePersonal],
              ['workspace', 'workbench.plugins_publish_scope_org', '组织', canPublish],
              ['public', 'workbench.plugins_publish_scope_all', '全部', canPublish],
            ] as const
          ).map(([value, key, fallback, enabled]) => (
            <button
              key={value}
              type="button"
              data-testid={`plugin-publish-scope-${value}`}
              disabled={!enabled}
              className={`h-10 rounded-lg text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
                visibility === value
                  ? 'bg-background font-medium shadow-sm'
                  : 'text-text-secondary hover:bg-background/60'
              }`}
              onClick={() => selectVisibility(value)}
            >
              {t(key, fallback)}
            </button>
          ))}
        </div>

        <p className="mt-3 text-xs leading-4 text-text-muted">{hint}</p>

        {visibility === 'personal' && (
          <div className="mt-4">
            <label className="relative block">
              <span className="sr-only">
                {t('workbench.plugins_share_search', '搜索成员或部门')}
              </span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                value={query}
                data-testid="plugin-publish-search"
                className="h-11 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
                placeholder={t(
                  'workbench.plugins_publish_people_placeholder',
                  '可选：搜索成员或部门；留空则仅自己可用'
                )}
                onChange={event => setQuery(event.target.value)}
              />
            </label>
            {query.trim() && (
              <div
                data-testid="plugin-publish-search-results"
                className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-border/30 p-1"
              >
                {searching && (
                  <p className="px-3 py-2 text-sm text-text-muted">
                    {t('workbench.plugins_share_searching', '正在搜索…')}
                  </p>
                )}
                {users.map(user => (
                  <button
                    key={`user-${user.id}`}
                    type="button"
                    data-testid={`plugin-publish-user-${user.id}`}
                    className="flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-left hover:bg-surface"
                    onClick={() =>
                      addTarget({
                        entityType: 'user',
                        entityId: String(user.id),
                        displayName: user.user_name,
                      })
                    }
                  >
                    <span className="text-sm font-medium">{user.user_name}</span>
                    <span className="text-xs text-text-muted">
                      {t('workbench.plugins_share_member', '成员')}
                    </span>
                  </button>
                ))}
                {groups.map(group => (
                  <button
                    key={`namespace-${group.id}`}
                    type="button"
                    data-testid={`plugin-publish-namespace-${group.id}`}
                    className="flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-left hover:bg-surface"
                    onClick={() =>
                      addTarget({
                        entityType: 'namespace',
                        entityId: String(group.id),
                        displayName: group.display_name || group.name,
                      })
                    }
                  >
                    <span className="text-sm font-medium">{group.display_name || group.name}</span>
                    <span className="text-xs text-text-muted">
                      {t('workbench.plugins_share_department', '部门')}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {targets.length > 0 && (
              <ul className="mt-3 space-y-2" data-testid="plugin-publish-targets">
                {targets.map(target => (
                  <li
                    key={`${target.entityType}-${target.entityId}`}
                    className="flex min-h-11 items-center justify-between rounded-lg bg-surface px-3"
                  >
                    <span className="text-sm">{target.displayName || target.entityId}</span>
                    <button
                      type="button"
                      className="text-xs text-text-muted hover:text-text-primary"
                      onClick={() =>
                        setTargets(current =>
                          current.filter(
                            item =>
                              !(
                                item.entityType === target.entityType &&
                                item.entityId === target.entityId
                              )
                          )
                        )
                      }
                    >
                      {t('common.remove', '移除')}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {targets.length > 0 && (
              <div className="mt-4 rounded-xl border border-border/30 p-3">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={allowCopy}
                    data-testid="plugin-publish-allow-copy"
                    className="mt-1 h-4 w-4 accent-neutral-900"
                    onChange={event => setAllowCopy(event.target.checked)}
                  />
                  <span>
                    <span className="block text-sm font-medium text-text-primary">
                      {t('workbench.plugins_share_allow_copy', '允许复制')}
                    </span>
                    <span className="mt-0.5 block text-xs text-text-muted">
                      {t('workbench.plugins_share_allow_copy_hint', '接收者可创建独立的本地副本')}
                    </span>
                  </span>
                </label>
              </div>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}

        <footer className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="h-10 rounded-lg px-4 text-sm hover:bg-surface"
            onClick={onClose}
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="plugin-publish-confirm"
            disabled={confirmDisabled}
            className="h-10 rounded-lg bg-text-primary px-4 text-sm font-medium text-background disabled:opacity-40"
            onClick={() =>
              onPublish({
                visibility,
                targets: visibility === 'personal' ? targets : [],
                allowCopy: visibility === 'personal' ? allowCopy : false,
              })
            }
          >
            {publishing
              ? t('workbench.plugins_publishing', '发布中…')
              : visibility === 'personal'
                ? t('workbench.plugins_publish_confirm', '发布')
                : t('workbench.plugins_publish_submit_review', '提交审核')}
          </button>
        </footer>
      </section>
    </div>
  )
}
