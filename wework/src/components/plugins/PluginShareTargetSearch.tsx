import type { PluginShareGroupSearchItem, PluginShareUserSearchItem } from '@/api/plugins'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginAccessTarget } from '@/types/api'
import { SearchableSelect } from '@wegent/collaboration/controls/SearchableSelect'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useEffect, useRef, useState } from 'react'

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
  const [users, setUsers] = useState<PluginShareUserSearchItem[]>([])
  const [groups, setGroups] = useState<PluginShareGroupSearchItem[]>([])
  const [searching, setSearching] = useState(false)
  const requestIdRef = useRef(0)
  const [error, setError] = useState(false)
  const [retryRevision, setRetryRevision] = useState(0)

  useEffect(() => {
    const normalized = query.trim()
    if (!normalized) return

    const requestId = ++requestIdRef.current
    const timeoutId = window.setTimeout(() => {
      void Promise.all([searchUsers(normalized), searchGroups(normalized)])
        .then(([nextUsers, nextGroups]) => {
          if (requestIdRef.current !== requestId) return
          setUsers(nextUsers)
          setGroups(nextGroups)
        })
        .catch(() => {
          if (requestIdRef.current !== requestId) return
          setUsers([])
          setGroups([])
          setError(true)
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setSearching(false)
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timeoutId)
      if (requestIdRef.current === requestId) requestIdRef.current += 1
    }
  }, [query, retryRevision, searchGroups, searchUsers])

  const clearSearch = () => {
    requestIdRef.current += 1
    setQuery('')
    setError(false)
    setUsers([])
    setGroups([])
    setSearching(false)
  }

  const handleQueryChange = (value: string) => {
    requestIdRef.current += 1
    setQuery(value)
    setError(false)
    setUsers([])
    setGroups([])
    setSearching(Boolean(value.trim()))
  }

  const selectTarget = (target: PluginAccessTarget) => {
    onSelect(target)
    clearSearch()
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
      onSearchChange={handleQueryChange}
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
        if (!next) clearSearch()
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
              onClick={() => {
                setError(false)
                setSearching(true)
                setRetryRevision(value => value + 1)
              }}
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
