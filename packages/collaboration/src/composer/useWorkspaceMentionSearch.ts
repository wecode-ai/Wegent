import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  RuntimeWorkspaceSearchItem,
  WorkspaceMentionSearchApi,
  WorkspaceMentionTarget,
} from './workspaceMentionTypes'

interface WorkspaceSearchState {
  key: string
  matches: RuntimeWorkspaceSearchItem[]
  loading: boolean
  error: boolean
}

export function useWorkspaceMentionSearch(
  query: string,
  target?: WorkspaceMentionTarget | null,
  workspaceFileApi?: WorkspaceMentionSearchApi
) {
  const [revision, setRevision] = useState(0)
  const retry = useCallback(() => setRevision(value => value + 1), [])
  const [searchState, setSearchState] = useState<WorkspaceSearchState>({
    key: '',
    matches: [],
    loading: false,
    error: false,
  })
  const normalizedQuery = query.trim()
  const deviceId = target?.deviceId
  const workspacePath = target?.path
  const search = workspaceFileApi?.searchWorkspaceEntries
  const activeKey =
    normalizedQuery && search && deviceId && workspacePath
      ? `${deviceId}\0${workspacePath}\0${normalizedQuery}`
      : ''

  useEffect(() => {
    if (!normalizedQuery || !deviceId || !workspacePath || !search) return

    let stale = false
    const searchKey = `${deviceId}\0${workspacePath}\0${normalizedQuery}`
    const cancellationToken = `composer-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = window.setTimeout(() => {
      setSearchState({ key: searchKey, matches: [], loading: true, error: false })
      void search(deviceId, workspacePath, normalizedQuery, cancellationToken)
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
  }, [deviceId, normalizedQuery, search, workspacePath, revision])

  const matches = useMemo(
    () => (searchState.key === activeKey ? searchState.matches : []),
    [activeKey, searchState.key, searchState.matches]
  )
  return {
    retry,
    matches,
    loading: Boolean(activeKey) && (searchState.key !== activeKey || searchState.loading),
    error: searchState.key === activeKey && searchState.error,
  }
}
