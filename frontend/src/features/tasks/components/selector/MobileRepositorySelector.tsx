// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { FolderGit2, Check, RefreshCw } from 'lucide-react'
import { Cog6ToothIcon } from '@heroicons/react/24/outline'
import { GitRepoInfo, TaskDetail } from '@/types/api'
import { useUser } from '@/features/common/UserContext'
import { useRouter } from 'next/navigation'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import { getLastRepo } from '@/utils/userPreferences'
import { githubApis } from '@/apis/github'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

interface MobileRepositorySelectorProps {
  selectedRepo: GitRepoInfo | null
  handleRepoChange: (repo: GitRepoInfo | null) => void
  disabled: boolean
  selectedTaskDetail?: TaskDetail | null
}

/**
 * Mobile-specific Repository Selector
 * Renders as a full-width clickable row that opens a popover
 */
export default function MobileRepositorySelector({
  selectedRepo,
  handleRepoChange,
  disabled,
  selectedTaskDetail,
}: MobileRepositorySelectorProps) {
  const { toast } = useToast()
  const { t } = useTranslation()
  const { user } = useUser()
  const router = useRouter()
  const [repos, setRepos] = useState<GitRepoInfo[]>([])
  const [cachedRepos, setCachedRepos] = useState<GitRepoInfo[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [_isSearching, setIsSearching] = useState<boolean>(false)
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false)
  const [currentSearchQuery, setCurrentSearchQuery] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const hasGitInfo = () => {
    return user && user.git_info && user.git_info.length > 0
  }

  const loadRepositories = async (): Promise<GitRepoInfo[]> => {
    if (!hasGitInfo()) {
      return []
    }

    setLoading(true)
    setError(null)

    try {
      const data = await githubApis.getRepositories()
      setRepos(data)
      setCachedRepos(data)
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
  }

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

  const searchRemoteRepos = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setRepos(cachedRepos)
        return
      }

      try {
        const results = await githubApis.searchRepositories(query, {
          fullmatch: false,
          timeout: 30,
        })

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
        console.error('Remote search failed, keeping local results')
      } finally {
        setIsSearching(false)
      }
    },
    [cachedRepos, searchLocalRepos]
  )

  const handleSearchChange = useCallback(
    (query: string) => {
      setCurrentSearchQuery(query)

      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current)
      }

      if (!query.trim()) {
        setRepos(cachedRepos)
        setIsSearching(false)
        return
      }

      setIsSearching(true)
      const localResults = searchLocalRepos(query)
      setRepos(localResults)

      searchTimeoutRef.current = setTimeout(() => {
        searchRemoteRepos(query)
      }, 1000)
    },
    [searchLocalRepos, searchRemoteRepos, cachedRepos]
  )

  const handleRefreshCache = useCallback(async () => {
    if (isRefreshing) return

    setIsRefreshing(true)
    try {
      await githubApis.refreshRepositories()

      if (currentSearchQuery.trim()) {
        const results = await githubApis.searchRepositories(currentSearchQuery, {
          fullmatch: false,
          timeout: 30,
        })
        setRepos(results)
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

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current)
      }
    }
  }, [])

  const handleChange = (value: string) => {
    let repo = repos.find(r => r.git_repo_id === Number(value))
    if (!repo) {
      repo = cachedRepos.find(r => r.git_repo_id === Number(value))
    }
    if (repo) {
      handleRepoChange(repo)
      setOpen(false)
    }
  }

  useEffect(() => {
    let canceled = false

    const selectRepository = async () => {
      const hasGit = hasGitInfo()
      if (!hasGit) return

      if (selectedTaskDetail?.git_repo) {
        if (selectedRepo?.git_repo === selectedTaskDetail.git_repo) return

        const repoInList = repos.find(r => r.git_repo === selectedTaskDetail.git_repo)
        if (repoInList) {
          handleRepoChange(repoInList)
          return
        }

        try {
          setLoading(true)
          const result = await githubApis.searchRepositories(selectedTaskDetail.git_repo, {
            fullmatch: true,
          })

          if (canceled) return

          if (result && result.length > 0) {
            const matched =
              result.find(r => r.git_repo === selectedTaskDetail.git_repo) ?? result[0]
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

      if (!selectedTaskDetail && !selectedRepo && !disabled) {
        let repoList = repos
        if (repoList.length === 0) {
          repoList = await loadRepositories()
          if (canceled || repoList.length === 0) return
        }

        const lastRepo = getLastRepo()
        if (lastRepo) {
          const repoToRestore = repoList.find(r => r.git_repo_id === lastRepo.repoId)
          if (repoToRestore) {
            handleRepoChange(repoToRestore)
          }
        }
      }
    }

    selectRepository()

    return () => {
      canceled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskDetail?.git_repo, disabled, user, repos.length])

  const handleIntegrationClick = () => {
    router.push(paths.settings.integrations.getHref())
  }

  const selectItems = useMemo(() => {
    const items = repos.map(repo => ({
      value: repo.git_repo_id.toString(),
      label: repo.git_repo,
    }))

    if (selectedRepo) {
      const hasSelected = items.some(item => item.value === selectedRepo.git_repo_id.toString())
      if (!hasSelected) {
        items.unshift({
          value: selectedRepo.git_repo_id.toString(),
          label: selectedRepo.git_repo,
        })
      }
    }

    return items
  }, [repos, selectedRepo])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled || loading}
          className={cn(
            'w-full flex items-center justify-between px-3 py-2.5',
            'text-left transition-colors',
            'hover:bg-hover active:bg-hover',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            loading && 'animate-pulse'
          )}
        >
          <div className="flex items-center gap-3">
            <FolderGit2 className="h-4 w-4 text-text-muted" />
            <span className="text-sm">仓库</span>
          </div>
          <span className="text-sm text-text-muted truncate max-w-[140px]">
            {selectedRepo?.git_repo || '未选择'}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          'p-0 w-[280px] border border-border bg-base',
          'shadow-xl rounded-xl overflow-hidden',
          'max-h-[400px] flex flex-col'
        )}
        align="end"
        side="top"
        sideOffset={4}
      >
        <Command
          className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden"
          shouldFilter={false}
        >
          <CommandInput
            placeholder={t('branches.search_repository')}
            onValueChange={handleSearchChange}
            className="h-9 rounded-none border-b border-border flex-shrink-0 placeholder:text-text-muted text-sm"
          />
          <CommandList className="min-h-[36px] max-h-[200px] overflow-y-auto flex-1">
            {error ? (
              <div className="py-4 px-3 text-center text-sm text-error">{error}</div>
            ) : selectItems.length === 0 ? (
              <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                {loading ? 'Loading...' : t('branches.select_repository')}
              </CommandEmpty>
            ) : (
              <>
                <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                  {t('branches.no_match')}
                </CommandEmpty>
                <CommandGroup>
                  {selectItems.map(item => (
                    <CommandItem
                      key={item.value}
                      value={item.label}
                      onSelect={() => handleChange(item.value)}
                      className={cn(
                        'cursor-pointer px-3 py-1.5 text-sm rounded-md mx-1 my-[2px]',
                        'data-[selected=true]:bg-primary/10 aria-selected:bg-hover',
                        '!flex !flex-row !items-center !gap-3'
                      )}
                    >
                      <Check
                        className={cn(
                          'h-3 w-3 shrink-0',
                          selectedRepo?.git_repo_id.toString() === item.value
                            ? 'opacity-100 text-primary'
                            : 'opacity-0'
                        )}
                      />
                      <span className="flex-1 min-w-0 truncate">{item.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
        <div className="border-t border-border bg-base flex items-center justify-between px-2.5 py-2 text-xs text-text-secondary">
          <div
            className="cursor-pointer flex items-center gap-2 hover:bg-muted rounded px-1 py-0.5"
            onClick={handleIntegrationClick}
            role="button"
            tabIndex={0}
          >
            <Cog6ToothIcon className="w-4 h-4" />
            <span>{t('branches.configure_integration')}</span>
          </div>
          <div
            className="cursor-pointer flex items-center gap-1.5 hover:bg-muted rounded px-1.5 py-0.5"
            onClick={handleRefreshCache}
            role="button"
            tabIndex={0}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', isRefreshing && 'animate-spin')} />
            <span>{isRefreshing ? t('branches.refreshing') : t('actions.refresh')}</span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
