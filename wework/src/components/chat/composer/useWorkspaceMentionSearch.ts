import { useEffect, useMemo, useState } from 'react'
import type { RuntimeWorkspaceSearchItem } from '@/types/api'
import type { WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'

interface WorkspaceSearchState {
  key: string
  matches: RuntimeWorkspaceSearchItem[]
  loading: boolean
  error: boolean
}

export function useWorkspaceMentionSearch(
  query: string,
  target?: WorkspaceTarget | null,
  workspaceFileApi?: WorkspaceFileApi
) {
  const [searchState, setSearchState] = useState<WorkspaceSearchState>({
    key: '',
    matches: [],
    loading: false,
    error: false,
  })
  const normalizedQuery = query.trim()
  const activeKey = target ? `${target.deviceId}\0${target.path}\0${normalizedQuery}` : ''

  useEffect(() => {
    const search = workspaceFileApi?.searchWorkspaceEntries
    if (!normalizedQuery || !target || !search) return

    let stale = false
    const searchKey = `${target.deviceId}\0${target.path}\0${normalizedQuery}`
    const cancellationToken = `composer-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = window.setTimeout(() => {
      setSearchState({ key: searchKey, matches: [], loading: true, error: false })
      void search(target.deviceId, target.path, normalizedQuery, cancellationToken)
        .then(response => {
          if (!stale) {
            setSearchState({
              key: searchKey,
              matches: response.files.slice(0, 50),
              loading: false,
              error: false,
            })
          }
        })
        .catch(() => {
          if (!stale) {
            setSearchState({ key: searchKey, matches: [], loading: false, error: true })
          }
        })
    }, 80)

    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [normalizedQuery, target, workspaceFileApi])

  const matches = useMemo(
    () => (searchState.key === activeKey ? searchState.matches : []),
    [activeKey, searchState.key, searchState.matches]
  )
  return {
    matches,
    loading: Boolean(activeKey) && (searchState.key !== activeKey || searchState.loading),
    error: searchState.key === activeKey && searchState.error,
  }
}
