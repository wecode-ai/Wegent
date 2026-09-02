// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, FolderGit2, GitBranch, Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'

import { githubApis } from '@/apis/github'
import { Command, CommandInput } from '@/components/ui/command'
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { paths } from '@/config/paths'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { GitBranch as GitBranchType, GitRepoInfo, TaskDetail } from '@/types/api'

import { useRepositorySearch } from '../../hooks/useRepositorySearch'
import { getRepositoryIdentity } from './repositoryIdentity'
import { RepositorySelectorFooter } from './RepositorySelectorFooter'

const INITIAL_VISIBLE_COUNT = 50
const LOAD_MORE_COUNT = 50

type WorkspaceSelectorStep = 'repository' | 'branch'

interface MobileRepositorySelectorProps {
  selectedRepo: GitRepoInfo | null
  handleRepoChange: (repo: GitRepoInfo | null) => void
  selectedBranch: GitBranchType | null
  handleBranchChange: (branch: GitBranchType | null) => void
  disabled: boolean
  selectedTaskDetail?: TaskDetail | null
  onSelectorOpenChange?: (open: boolean) => void
}

export default function MobileRepositorySelector({
  selectedRepo,
  handleRepoChange,
  selectedBranch,
  handleBranchChange,
  disabled,
  selectedTaskDetail,
  onSelectorOpenChange,
}: MobileRepositorySelectorProps) {
  const { t } = useTranslation('chat')
  const { toast } = useToast()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<WorkspaceSelectorStep>('repository')
  const [activeRepo, setActiveRepo] = useState<GitRepoInfo | null>(selectedRepo)
  const [branches, setBranches] = useState<GitBranchType[]>([])
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)
  const [branchSearch, setBranchSearch] = useState('')
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
  const listRef = useRef<HTMLDivElement>(null)

  const {
    repos,
    loading,
    isRefreshing,
    error,
    currentSearchQuery,
    handleSearchChange,
    handleRefreshCache,
    resetSearch,
  } = useRepositorySearch({
    selectedRepo,
    handleRepoChange,
    disabled,
    selectedTaskDetail,
  })

  const prevReposRef = useRef(repos)
  useEffect(() => {
    const previousRepos = prevReposRef.current
    const changed =
      previousRepos.length !== repos.length ||
      (repos.length > 0 &&
        previousRepos.length > 0 &&
        previousRepos[0]?.git_repo_id !== repos[0]?.git_repo_id)

    if (changed) {
      setVisibleCount(INITIAL_VISIBLE_COUNT)
      prevReposRef.current = repos
    }
  }, [repos])

  useEffect(() => {
    setActiveRepo(selectedRepo)
    setBranchSearch('')
    setBranchError(null)

    if (!selectedRepo) {
      setBranches([])
      setBranchLoading(false)
      return
    }

    let ignore = false
    setBranchLoading(true)
    githubApis
      .getBranches(selectedRepo)
      .then(data => {
        if (ignore) return

        setBranches(data)
        setBranchError(null)

        const selectedStillExists = selectedBranch
          ? data.find(branch => branch.name === selectedBranch.name)
          : null
        if (selectedStillExists) return

        const taskBranchName =
          selectedTaskDetail && 'branch_name' in selectedTaskDetail
            ? selectedTaskDetail.branch_name
            : null
        const preferredBranch =
          data.find(branch => branch.name === taskBranchName) ??
          data.find(branch => branch.default) ??
          null
        handleBranchChange(preferredBranch)
      })
      .catch(() => {
        if (ignore) return
        const message = t('common:branches.load_failed')
        setBranchError(message)
        toast({ variant: 'destructive', title: message })
      })
      .finally(() => {
        if (!ignore) setBranchLoading(false)
      })

    return () => {
      ignore = true
    }
    // Repository identity is the fetch boundary; callbacks may be recreated by the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepo])

  const repositoryItems = useMemo(() => {
    const seen = new Set<string>()
    const items = repos
      .filter(repo => {
        const key = getRepositoryIdentity(repo)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map(repo => ({
        value: getRepositoryIdentity(repo),
        label: repo.git_repo,
        repo,
      }))

    if (selectedRepo) {
      const selectedIdentity = getRepositoryIdentity(selectedRepo)
      if (!items.some(item => item.value === selectedIdentity)) {
        items.unshift({
          value: selectedIdentity,
          label: selectedRepo.git_repo,
          repo: selectedRepo,
        })
      }
    }

    return items
  }, [repos, selectedRepo])

  const visibleRepositoryItems = useMemo(
    () => repositoryItems.slice(0, visibleCount),
    [repositoryItems, visibleCount]
  )
  const hasMoreRepositories = repositoryItems.length > visibleCount
  const filteredBranches = useMemo(() => {
    const query = branchSearch.trim().toLowerCase()
    if (!query) return branches
    return branches.filter(branch => branch.name.toLowerCase().includes(query))
  }, [branchSearch, branches])

  const handleScroll = useCallback(() => {
    if (!listRef.current || !hasMoreRepositories) return

    const { scrollTop, scrollHeight, clientHeight } = listRef.current
    if (scrollTop + clientHeight >= scrollHeight - 50) {
      setVisibleCount(previous => Math.min(previous + LOAD_MORE_COUNT, repositoryItems.length))
    }
  }, [hasMoreRepositories, repositoryItems.length])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if ((disabled || loading) && nextOpen) return

      setOpen(nextOpen)
      onSelectorOpenChange?.(nextOpen)
      if (nextOpen) {
        setStep('repository')
        setActiveRepo(selectedRepo)
        return
      }

      resetSearch()
      setBranchSearch('')
      setStep('repository')
    },
    [disabled, loading, onSelectorOpenChange, resetSearch, selectedRepo]
  )

  const handleRepositorySelect = (repo: GitRepoInfo) => {
    const repositoryChanged =
      !selectedRepo || getRepositoryIdentity(selectedRepo) !== getRepositoryIdentity(repo)

    setActiveRepo(repo)
    setStep('branch')
    setBranchSearch('')

    if (repositoryChanged) {
      setBranches([])
      setBranchError(null)
      setBranchLoading(true)
      handleBranchChange(null)
      handleRepoChange(repo)
    }
  }

  const handleBranchSelect = (branch: GitBranchType) => {
    handleBranchChange(branch)
    handleOpenChange(false)
  }

  const handleIntegrationClick = () => {
    handleOpenChange(false)
    router.push(paths.settings.integrations.getHref())
  }

  const selectedWorkspace = selectedRepo
    ? `${selectedRepo.git_repo}${selectedBranch ? ` · ${selectedBranch.name}` : ''}`
    : t('mobile_composer.not_selected')

  return (
    <Drawer open={open} onOpenChange={handleOpenChange} shouldScaleBackground={false}>
      <DrawerTrigger asChild>
        <button
          type="button"
          disabled={disabled || loading}
          data-testid="mobile-repository-selector-trigger"
          className={cn(
            'flex w-full items-center justify-between px-3 py-2.5 text-left',
            'transition-colors hover:bg-hover active:bg-hover',
            'disabled:cursor-not-allowed disabled:opacity-50',
            loading && 'animate-pulse'
          )}
        >
          <span className="flex min-w-0 items-center gap-3">
            <FolderGit2 className="h-4 w-4 shrink-0 text-text-muted" />
            <span className="text-sm">{t('mobile_composer.workspace')}</span>
          </span>
          <span className="ml-3 max-w-[160px] truncate text-sm text-text-muted">
            {selectedWorkspace}
          </span>
        </button>
      </DrawerTrigger>

      <DrawerContent
        className="max-h-[85vh] overflow-hidden bg-[#f2f2f7] dark:bg-[#1c1c1e]"
        showHandle={false}
        data-testid="mobile-repository-selector-drawer"
      >
        <div className="flex justify-center pb-3 pt-2">
          <div className="h-1 w-9 rounded-full bg-[#3c3c43]/30 dark:bg-[#5c5c5e]" />
        </div>

        <DrawerTitle className="px-4 pb-2 text-base font-semibold text-text-primary">
          {step === 'repository' ? t('common:repos.repository') : t('common:repos.branch')}
        </DrawerTitle>

        {step === 'branch' && (
          <button
            type="button"
            onClick={() => {
              setStep('repository')
              setBranchSearch('')
            }}
            className="mx-4 mb-2 flex min-h-11 max-w-[calc(100%-32px)] items-center gap-1 text-primary active:opacity-70"
            data-testid="mobile-workspace-back-to-repositories"
          >
            <ChevronLeft className="h-5 w-5 shrink-0" />
            <span className="truncate text-sm font-medium">{activeRepo?.git_repo}</span>
          </button>
        )}

        <Command
          className={cn(
            'min-h-0 flex-1 rounded-none border-0 bg-transparent',
            '[&_[cmdk-input-wrapper]]:mx-4 [&_[cmdk-input-wrapper]]:mb-3',
            '[&_[cmdk-input-wrapper]]:rounded-lg [&_[cmdk-input-wrapper]]:border-0',
            '[&_[cmdk-input-wrapper]]:bg-[#e5e5ea] dark:[&_[cmdk-input-wrapper]]:bg-[#2c2c2e]'
          )}
          shouldFilter={false}
        >
          <CommandInput
            placeholder={
              step === 'repository'
                ? t('common:branches.search_repository')
                : t('common:branches.search_branch')
            }
            onValueChange={
              step === 'repository' ? handleSearchChange : value => setBranchSearch(value)
            }
            value={step === 'repository' ? currentSearchQuery : branchSearch}
            className="h-11 flex-shrink-0 text-sm placeholder:text-text-muted"
          />

          <div
            ref={listRef}
            onScroll={step === 'repository' ? handleScroll : undefined}
            className="mx-4 min-h-[44px] max-h-[55vh] flex-1 overflow-y-auto rounded-xl bg-white dark:bg-[#2c2c2e]"
          >
            {step === 'repository' ? (
              error ? (
                <div className="px-3 py-4 text-center text-sm text-error">{error}</div>
              ) : repositoryItems.length === 0 ? (
                <div className="px-3 py-4 text-center text-sm text-text-muted">
                  {loading ? t('common:loading') : t('common:branches.select_repository')}
                </div>
              ) : (
                <>
                  {visibleRepositoryItems.map((item, index) => (
                    <button
                      type="button"
                      key={item.value}
                      onClick={() => handleRepositorySelect(item.repo)}
                      data-testid="mobile-repository-option"
                      className={cn(
                        'flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left text-sm',
                        'active:bg-hover',
                        index !== visibleRepositoryItems.length - 1 && 'border-b border-border'
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {selectedRepo && getRepositoryIdentity(selectedRepo) === item.value && (
                        <Check className="h-4 w-4 shrink-0 text-primary" />
                      )}
                    </button>
                  ))}
                  {hasMoreRepositories && (
                    <div className="flex items-center justify-center gap-2 px-3 py-2 text-xs text-text-muted">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>{t('common:repos.scroll_to_load_more')}</span>
                    </div>
                  )}
                </>
              )
            ) : branchError ? (
              <div className="px-3 py-4 text-center text-sm text-error">{branchError}</div>
            ) : branchLoading ? (
              <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{t('common:branches.loading')}</span>
              </div>
            ) : filteredBranches.length === 0 ? (
              <div className="px-3 py-4 text-center text-sm text-text-muted">
                {branchSearch ? t('common:branches.no_match') : t('common:branches.no_branch')}
              </div>
            ) : (
              filteredBranches.map((branch, index) => (
                <button
                  type="button"
                  key={branch.name}
                  onClick={() => handleBranchSelect(branch)}
                  data-testid="mobile-branch-option"
                  className={cn(
                    'flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left text-sm',
                    'active:bg-hover',
                    index !== filteredBranches.length - 1 && 'border-b border-border'
                  )}
                >
                  <GitBranch className="h-4 w-4 shrink-0 text-text-muted" />
                  <span className="min-w-0 flex-1 truncate">
                    {branch.name}
                    {branch.default && (
                      <span className="ml-2 text-xs text-green-500">
                        {t('common:branches.default')}
                      </span>
                    )}
                  </span>
                  {selectedBranch?.name === branch.name && (
                    <Check className="h-4 w-4 shrink-0 text-primary" />
                  )}
                </button>
              ))
            )}
          </div>
        </Command>

        {step === 'repository' && (
          <div className="px-4 pb-4 pt-3">
            <div className="overflow-hidden rounded-xl bg-white dark:bg-[#2c2c2e]">
              <RepositorySelectorFooter
                onConfigureClick={handleIntegrationClick}
                onRefreshClick={handleRefreshCache}
                isRefreshing={isRefreshing}
              />
            </div>
          </div>
        )}
      </DrawerContent>
    </Drawer>
  )
}
