import { Search } from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { PluginShareGroupSearchItem, PluginShareUserSearchItem } from '@/api/plugins'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginAccessTarget } from '@/types/api'

const SEARCH_DEBOUNCE_MS = 180

interface PluginShareTargetSearchProps {
  inputRef?: RefObject<HTMLInputElement | null>
  searchUsers: (query: string) => Promise<PluginShareUserSearchItem[]>
  searchGroups: (query: string) => Promise<PluginShareGroupSearchItem[]>
  onSelect: (target: PluginAccessTarget) => void
}

export function PluginShareTargetSearch({
  inputRef,
  searchUsers,
  searchGroups,
  onSelect,
}: PluginShareTargetSearchProps) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState<PluginShareUserSearchItem[]>([])
  const [groups, setGroups] = useState<PluginShareGroupSearchItem[]>([])
  const [searching, setSearching] = useState(false)
  const requestIdRef = useRef(0)

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
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setSearching(false)
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timeoutId)
      if (requestIdRef.current === requestId) requestIdRef.current += 1
    }
  }, [query, searchGroups, searchUsers])

  const clearSearch = () => {
    requestIdRef.current += 1
    setQuery('')
    setUsers([])
    setGroups([])
    setSearching(false)
  }

  const handleQueryChange = (value: string) => {
    requestIdRef.current += 1
    setQuery(value)
    setUsers([])
    setGroups([])
    setSearching(Boolean(value.trim()))
  }

  const selectTarget = (target: PluginAccessTarget) => {
    onSelect(target)
    clearSearch()
  }

  return (
    <div className="relative">
      <label className="relative block">
        <span className="sr-only">{t('workbench.plugins_share_search', '搜索成员或部门')}</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input
          ref={inputRef}
          value={query}
          data-testid="plugin-share-search"
          className="h-11 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
          placeholder={t('workbench.plugins_share_search', '搜索成员或部门')}
          onChange={event => handleQueryChange(event.target.value)}
        />
      </label>
      {query.trim() ? (
        <div
          data-testid="plugin-share-search-results"
          className="absolute inset-x-0 top-full z-popover mt-2 max-h-48 min-h-11 overflow-y-auto rounded-xl border border-border/30 bg-popover p-1 shadow-lg"
        >
          {searching ? (
            <p role="status" className="px-3 py-2 text-sm text-text-muted">
              {t('workbench.plugins_share_searching', '正在搜索…')}
            </p>
          ) : null}
          {users.map(user => (
            <button
              key={`user-${user.id}`}
              type="button"
              data-testid={`plugin-share-user-${user.id}`}
              className="flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-left hover:bg-surface"
              onClick={() =>
                selectTarget({
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
              data-testid={`plugin-share-namespace-${group.id}`}
              className="flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-left hover:bg-surface"
              onClick={() =>
                selectTarget({
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
      ) : null}
    </div>
  )
}
