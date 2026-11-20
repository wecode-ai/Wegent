import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type { PluginShareGroupSearchItem, PluginShareUserSearchItem } from '@/api/plugins'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginAccessTarget } from '@/types/api'
import { SearchableSelect } from '@wegent/collaboration/controls/SearchableSelect'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useMemo, useState, useSyncExternalStore } from 'react'

const SEARCH_DEBOUNCE_MS = 180

interface PluginShareTargetSearchProps {
  searchUsers: (query: string) => Promise<PluginShareUserSearchItem[]>
  searchGroups: (query: string) => Promise<PluginShareGroupSearchItem[]>
  onSelect: (target: PluginAccessTarget) => void
}

export function PluginShareTargetSearch({
  searchUsers,
  searchGroups,
  onSelect,
}: PluginShareTargetSearchProps) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(true)
  const normalizedQuery = query.trim()
  const resource = useMemo(
    () =>
      createAsyncResource(
        normalizedQuery,
        async () => {
          const [users, groups] = await Promise.all([
            searchUsers(normalizedQuery),
            searchGroups(normalizedQuery),
          ])
          return { users, groups }
        },
        { delayMs: SEARCH_DEBOUNCE_MS, refreshOnSubscribe: true }
      ),
    [normalizedQuery, searchGroups, searchUsers]
  )
  const result = useSyncExternalStore(
    normalizedQuery ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const users = result.data?.users ?? []
  const groups = result.data?.groups ?? []
  const searching = Boolean(
    normalizedQuery && (result.status === 'idle' || result.status === 'loading')
  )
  const error = result.status === 'error'

  const selectTarget = (target: PluginAccessTarget) => {
    onSelect(target)
    setQuery('')
  }

  const targets: PluginAccessTarget[] = [
    ...users.map(user => ({
      entityType: 'user' as const,
      entityId: String(user.id),
      displayName: user.user_name,
    })),
    ...groups.map(group => ({
      entityType: 'namespace' as const,
      entityId: String(group.id),
      displayName: group.display_name || group.name,
    })),
  ]
  const uniqueTargets = [
    ...new Map(targets.map(target => [target.entityType + ':' + target.entityId, target])).values(),
  ]
  const searchLabel = t('workbench.plugins_share_search', '搜索成员或部门')
  return (
    <SearchableSelect
      testId="plugin-share-search-trigger"
      searchTestId="plugin-share-search"
      menuTestId="plugin-share-search-results"
      accessibleLabel={searchLabel}
      searchPlaceholder={searchLabel}
      emptyLabel={t('todo.no_search_members', '没有匹配的成员')}
      open={open}
      value=""
      query={query}
      onSearchChange={setQuery}
      filter={false}
      options={uniqueTargets.map(target => ({
        value: target.entityType + ':' + target.entityId,
        label: target.displayName,
        description:
          target.entityType === 'user'
            ? t('workbench.plugins_share_member', '成员')
            : t('workbench.plugins_share_department', '部门'),
        testId: 'plugin-share-' + target.entityType + '-' + target.entityId,
      }))}
      onChange={value => {
        const target = uniqueTargets.find(
          target => target.entityType + ':' + target.entityId === value
        )
        if (target) selectTarget(target)
      }}
      onOpenChange={next => {
        setOpen(next)
        if (!next) setQuery('')
      }}
      searchStatus={
        searching ? (
          <p role="status" className="px-3 py-2 text-sm text-text-secondary">
            {t('workbench.plugins_share_searching', '正在搜索…')}
          </p>
        ) : error ? (
          <div role="alert" className="flex items-center gap-2 p-2 text-sm text-destructive">
            <span>{t('workbench.mention_search_error', '搜索失败')}</span>
            <ControlButton
              variant="ghost"
              data-testid="plugin-share-search-retry"
              onClick={() => void resource.reload()}
            >
              {t('workbench.retry', '重试')}
            </ControlButton>
          </div>
        ) : !query.trim() ? (
          <p className="px-3 py-2 text-sm text-text-secondary">{searchLabel}</p>
        ) : undefined
      }
    />
  )
}
