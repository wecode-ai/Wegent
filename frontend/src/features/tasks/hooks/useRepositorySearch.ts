// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { GitRepoInfo, TaskDetail } from '@/types/api'
import { useUser } from '@/features/common/UserContext'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { githubApis } from '@/apis/github'
import { getLastRepo } from '@/utils/userPreferences'

export interface UseRepositorySearchOptions {
  selectedRepo: GitRepoInfo | null
  handleRepoChange: (repo: GitRepoInfo | null) => void
  disabled: boolean
  selectedTaskDetail?: TaskDetail | null
}

export interface UseRepositorySearchReturn {
  // State
  repos: GitRepoInfo[]
  cachedRepos: GitRepoInfo[]
  loading: boolean
  isSearching: boolean
  isRefreshing: boolean
  error: string | null
  currentSearchQuery: string

  // Methods
  handleSearchChange: (query: string) => void
  handleRefreshCache: () => Promise<void>
  handleChange: (value: string) => void

  // Helpers
  hasGitInfo: () => boolean
}

/**
 * Custom hook for repository search functionality
 * Handles loading, caching, searching (local + remote), and refreshing repositories
 */
export function useRepositorySearch({
  selectedRepo,
  handleRepoChange,
  disabled,
  selectedTaskDetail,
}: UseRepositorySearchOptions): UseRepositorySearchReturn {
  const { toast } = useToast()
  const { t } = useTranslation()
  const { user } = useUser()

  // State
  const [repos, setRepos] = useState<GitRepoInfo[]>([])
  const [cachedRepos, setCachedRepos] = useState<GitRepoInfo[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [isSearching, setIsSearching] = useState<boolean>(false)
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false)
  const [currentSearchQuery, setCurrentSearchQuery] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [hasInitiallyLoaded, setHasInitiallyLoaded] = useState<boolean>(false)

  // Refs for debouncing and race condition handling
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const searchRequestIdRef = useRef<number>(0)

  /**
   * Check if user has git_info configured
   */
  const hasGitInfo = useCallback((): boolean => {
    return !!(user && user.git_info && user.git_info.length > 0)
  }, [user])

  /**
   * Load repositories from API
   */
  const loadRepositories = useCallback(async (): Promise<GitRepoInfo[]> => {
    if (!hasGitInfo()) {
      return []
    }

    setLoading(true)
    setError(null)

    try {
      const data = await githubApis.getRepositories()
      setRepos(data)
      setCachedRepos(data)
      setHasInitiallyLoaded(true)
      setError(null)
      return data
    } catch {
      setError('Failed to load repositories')
      toast({
        variant: 'destructive',
        title: 'Failed to load repositories',
      })
      return []
    } finally {
      setLoading(false)
    }
  }, [hasGitInfo, toast])

  /**
   * Search repositories locally (in cache)
   */
  const searchLocalRepos = useCallback(
    (query: string): GitRepoInfo[] => {
      if (!query.trim()) {
        return cachedRepos
      }
      const lowerQuery = query.toLowerCase()
      return cachedRepos.filter(repo => repo.git_repo.toLowerCase().includes(lowerQuery))
    },
    [cachedRepos]
  )

  /**
   * Search repositories remotely (delayed execution)
   */
  const searchRemoteRepos = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setRepos(cachedRepos)
        setIsSearching(false)
        return
      }

      const requestId = ++searchRequestIdRef.current

      try {
        const results = await githubApis.searchRepositories(query, {
          fullmatch: false,
          timeout: 30,
        })

        if (requestId !== searchRequestIdRef.current) {
          return
        }

        // Merge local and remote results, remove duplicates
        const localResults = searchLocalRepos(query)
        const mergedResults = [...localResults]

        results.forEach(remoteRepo => {
          if (!mergedResults.find(r => r.git_repo_id === remoteRepo.git_repo_id)) {
            mergedResults.push(remoteRepo)
          }
        })

        setRepos(mergedResults)
        setError(null)
      } catch {
        if (requestId === searchRequestIdRef.current) {
          console.error('Remote search failed, keeping local results')
        }
      } finally {
        if (requestId === searchRequestIdRef.current) {
          setIsSearching(false)
        }
      }
    },
    [cachedRepos, searchLocalRepos]
  )

  /**
   * Handle search input changes with debouncing
   */
  const handleSearchChange = useCallback(
    (query: string) => {
      setCurrentSearchQuery(query)

      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current)
      }

      if (!query.trim()) {
        searchRequestIdRef.current++
        setRepos(cachedRepos)
        setIsSearching(false)
        return
      }

      setIsSearching(true)

      // Immediately perform local search
      const localResults = searchLocalRepos(query)
      setRepos(localResults)

      // Delay remote search for better responsiveness
      searchTimeoutRef.current = setTimeout(() => {
        searchRemoteRepos(query)
      }, 300)
    },
    [searchLocalRepos, searchRemoteRepos, cachedRepos]
  )

  /**
   * Handle refresh cache button click
   */
  const handleRefreshCache = useCallback(async () => {
    if (isRefreshing) return

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current)
    }
    searchRequestIdRef.current++
    setIsSearching(false)

    setIsRefreshing(true)
    try {
      await githubApis.refreshRepositories()

      if (currentSearchQuery.trim()) {
        const requestId = ++searchRequestIdRef.current
        const results = await githubApis.searchRepositories(currentSearchQuery, {
          fullmatch: false,
          timeout: 30,
        })
        if (requestId === searchRequestIdRef.current) {
          setRepos(results)
        }
      } else {
        const data = await githubApis.getRepositories()
        setRepos(data)
        setCachedRepos(data)
      }

      toast({ title: t('branches.refresh_success') })
    } catch {
      toast({ variant: 'destructive', title: t('branches.refresh_failed') })
    } finally {
      setIsRefreshing(false)
    }
  }, [isRefreshing, currentSearchQuery, toast, t])

  /**
   * Handle repository selection change
   */
  const handleChange = useCallback(
    (value: string) => {
      let repo = repos.find(r => r.git_repo_id === Number(value))

      if (!repo) {
        repo = cachedRepos.find(r => r.git_repo_id === Number(value))
      }

      if (repo) {
        handleRepoChange(repo)
      }
    },
    [repos, cachedRepos, handleRepoChange]
  )

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current)
      }
    }
  }, [])

  /**
   * Centralized repository selection logic
   * Handles all scenarios: mount, task selection, and restoration
   */
  useEffect(() => {
    let canceled = false

    const selectRepository = async () => {
      const hasGit = hasGitInfo()
      console.log('[RepositorySelector] Effect triggered', {
        hasGitInfo: hasGit,
        user: user ? 'loaded' : 'null',
        gitInfoLength: user?.git_info?.length || 0,
        selectedTaskDetail: selectedTaskDetail?.git_repo || 'none',
        selectedRepo: selectedRepo?.git_repo || 'none',
        disabled,
        reposLength: repos.length,
      })

      if (!hasGit) {
        console.log('[RepositorySelector] No git info, exiting')
        return
      }

      // Scenario 1: Task is selected - use task's repository
      if (selectedTaskDetail?.git_repo) {
        console.log(
          '[RepositorySelector] Scenario 1: Task selected, repo:',
          selectedTaskDetail.git_repo
        )

        if (selectedRepo?.git_repo === selectedTaskDetail.git_repo) {
          console.log('[RepositorySelector] Already selected, no change needed')
          return
        }

        const repoInList = repos.find(r => r.git_repo === selectedTaskDetail.git_repo)
        if (repoInList) {
          console.log('[RepositorySelector] Found in list, selecting:', repoInList.git_repo)
          handleRepoChange(repoInList)
          return
        }

        console.log('[RepositorySelector] Not in list, searching via API')
        try {
          setLoading(true)
          const result = await githubApis.searchRepositories(selectedTaskDetail.git_repo, {
            fullmatch: true,
          })

          if (canceled) return

          if (result && result.length > 0) {
            const matched =
              result.find(r => r.git_repo === selectedTaskDetail.git_repo) ?? result[0]
            console.log('[RepositorySelector] Found via API, selecting:', matched.git_repo)
            handleRepoChange(matched)
            setError(null)
          } else {
            toast({
              variant: 'destructive',
              title: 'No repositories found',
            })
          }
        } catch {
          setError('Failed to search repositories')
          toast({
            variant: 'destructive',
            title: 'Failed to search repositories',
          })
        } finally {
          if (!canceled) {
            setLoading(false)
          }
        }
        return
      }

      // Scenario 2: No task selected and no repo selected - load repos and restore from localStorage
      if (!selectedTaskDetail && !selectedRepo && !disabled) {
        console.log('[RepositorySelector] Scenario 2: Load repos and restore from localStorage')

        let repoList = repos
        if (repoList.length === 0 && !hasInitiallyLoaded) {
          console.log('[RepositorySelector] Repos not loaded, loading now...')
          repoList = await loadRepositories()
          console.log('[RepositorySelector] Loaded repos count:', repoList.length)
          if (canceled || repoList.length === 0) {
            console.log('[RepositorySelector] Load failed or canceled')
            return
          }
        }

        const lastRepo = getLastRepo()
        console.log('[RepositorySelector] Last repo from storage:', lastRepo)

        if (lastRepo) {
          const repoToRestore = repoList.find(r => r.git_repo_id === lastRepo.repoId)
          if (repoToRestore) {
            console.log(
              '[RepositorySelector] ✅ Restoring repo from localStorage:',
              repoToRestore.git_repo
            )
            handleRepoChange(repoToRestore)
          } else {
            console.log('[RepositorySelector] ❌ Repo not found in list, ID:', lastRepo.repoId)
          }
        } else {
          console.log('[RepositorySelector] No last repo in storage, repos loaded but no selection')
        }
      } else {
        console.log('[RepositorySelector] Scenario 2 conditions not met:', {
          hasTaskDetail: !!selectedTaskDetail,
          hasSelectedRepo: !!selectedRepo,
          disabled,
        })
      }
    }

    selectRepository()

    return () => {
      canceled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskDetail?.git_repo, disabled, user, hasInitiallyLoaded])

  return {
    repos,
    cachedRepos,
    loading,
    isSearching,
    isRefreshing,
    error,
    currentSearchQuery,
    handleSearchChange,
    handleRefreshCache,
    handleChange,
    hasGitInfo,
  }
}
