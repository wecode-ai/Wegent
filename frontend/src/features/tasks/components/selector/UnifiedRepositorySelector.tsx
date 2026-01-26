// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import * as React from 'react'
import { useState, useEffect, useMemo, useCallback, useContext } from 'react'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  Loader2,
  GitBranch as GitBranchIcon,
  FolderGit2,
  FolderX,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { cn } from '@/lib/utils'
import { paths } from '@/config/paths'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

import { truncateMiddle } from '@/utils/stringUtils'
import { GitRepoInfo, GitBranch, TaskDetail } from '@/types/api'
import { githubApis } from '@/apis/github'
import { useToast } from '@/hooks/use-toast'
import { useRepositorySearch } from '../../hooks/useRepositorySearch'
import { RepositorySelectorFooter } from './RepositorySelectorFooter'
import { TaskContext } from '../../contexts/taskContext'

/**
 * Props for UnifiedRepositorySelector component
 */
export interface UnifiedRepositorySelectorProps {
  selectedRepo: GitRepoInfo | null
  selectedBranch: GitBranch | null
  onRepoChange: (repo: GitRepoInfo | null) => void
  onBranchChange: (branch: GitBranch | null) => void
  disabled?: boolean
  className?: string
  /** Optional task detail for auto-sync */
  taskDetail?: TaskDetail | null
  /** When true, display only icon without text (for responsive collapse) */
  compact?: boolean
  /** Whether workspace is required (can be overridden by user) */
  requiresWorkspace?: boolean
  /** Callback when user toggles the requires workspace switch */
  onRequiresWorkspaceChange?: (value: boolean) => void
}

/**
 * View state for the unified selector
 */
type SelectorView = 'repo' | 'branch'

/**
 * UnifiedRepositorySelector component
 * Provides unified repository and branch selection in a single Popover
 */
export default function UnifiedRepositorySelector({
  selectedRepo,
  selectedBranch,
  onRepoChange,
  onBranchChange,
  disabled = false,
  className,
  taskDetail,
  compact = false,
  requiresWorkspace = true,
  onRequiresWorkspaceChange,
}: UnifiedRepositorySelectorProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const { toast } = useToast()
  const isMobile = useIsMobile()

  // Popover state
  const [isOpen, setIsOpen] = useState(false)
  const [currentView, setCurrentView] = useState<SelectorView>('repo')

  // Branch state
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)
  const [userCleared, setUserCleared] = useState(false)

  // Try to get context, but don't throw if not available
  const taskContext = useContext(TaskContext)
  const selectedTaskDetail = taskDetail ?? taskContext?.selectedTaskDetail ?? null

  // Use the custom hook for repository search logic
  const {
    repos,
    loading: repoLoading,
    isSearching,
    isRefreshing,
    error: repoError,
    handleSearchChange,
    handleRefreshCache,
    handleChange: handleRepoSelectFromSearch,
  } = useRepositorySearch({
    selectedRepo,
    handleRepoChange: onRepoChange,
    disabled,
    selectedTaskDetail,
  })

  // Convert repos to items
  const repoItems = useMemo(() => {
    const items = repos.map(repo => ({
      value: repo.git_repo_id.toString(),
      label: repo.git_repo,
      searchText: repo.git_repo,
    }))

    // Ensure selected repo is in the items list
    if (selectedRepo) {
      const hasSelected = items.some(item => item.value === selectedRepo.git_repo_id.toString())
      if (!hasSelected) {
        items.unshift({
          value: selectedRepo.git_repo_id.toString(),
          label: selectedRepo.git_repo,
          searchText: selectedRepo.git_repo,
        })
      }
    }

    return items
  }, [repos, selectedRepo])

  // Convert branches to items
  const branchItems = useMemo(() => {
    return branches.map(branch => ({
      value: branch.name,
      label: branch.name,
      searchText: branch.name,
      isDefault: branch.default,
    }))
  }, [branches])

  // Fetch branches when repo changes
  useEffect(() => {
    // Clear previous branches immediately when repo changes to avoid showing stale data
    setBranches([])
    setBranchError(null)
    setUserCleared(false)
    onBranchChange(null)

    if (!selectedRepo) {
      setBranchLoading(false)
      return
    }

    let ignore = false
    setBranchLoading(true)

    githubApis
      .getBranches(selectedRepo)
      .then(data => {
        if (!ignore) {
          setBranches(data)
          setBranchError(null)
        }
      })
      .catch(() => {
        if (!ignore) {
          setBranchError(t('common:branches.load_failed'))
          toast({
            variant: 'destructive',
            title: t('common:branches.load_failed'),
          })
        }
      })
      .finally(() => {
        if (!ignore) setBranchLoading(false)
      })

    return () => {
      ignore = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepo])

  // Auto-select branch from task detail or default
  useEffect(() => {
    if (!branches || branches.length === 0) return
    if (userCleared) return

    if (
      selectedTaskDetail &&
      'branch_name' in selectedTaskDetail &&
      selectedTaskDetail.branch_name
    ) {
      const foundBranch = branches.find(b => b.name === selectedTaskDetail.branch_name) || null
      if (foundBranch) {
        onBranchChange(foundBranch)
        return
      }
    }

    // If no task or not found, select default branch
    if (!selectedBranch) {
      const defaultBranch = branches.find(b => b.default)
      if (defaultBranch) {
        onBranchChange(defaultBranch)
      } else {
        onBranchChange(null)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskDetail, branches, userCleared])

  // Reset userCleared when repo or task changes
  useEffect(() => {
    setUserCleared(false)
  }, [selectedRepo, selectedTaskDetail?.branch_name])

  // Reset view when popover closes
  useEffect(() => {
    if (!isOpen) {
      setCurrentView('repo')
    }
  }, [isOpen])

  // Navigate to settings page
  const handleIntegrationClick = () => {
    router.push(paths.settings.integrations.getHref())
    setIsOpen(false)
  }

  // Handle repo selection
  const handleRepoSelect = useCallback(
    (value: string) => {
      handleRepoSelectFromSearch(value)
      // After selecting repo, automatically switch to branch view
      setCurrentView('branch')
    },
    [handleRepoSelectFromSearch]
  )

  // Handle branch selection
  const handleBranchSelect = useCallback(
    (value: string) => {
      const branch = branches.find(b => b.name === value)
      if (branch) {
        setUserCleared(false)
        onBranchChange(branch)
        setIsOpen(false)
      }
    },
    [branches, onBranchChange]
  )

  // Go back to repo view
  const handleBackToRepo = useCallback(() => {
    setCurrentView('repo')
  }, [])

  // Handle requires workspace toggle
  const handleRequiresWorkspaceToggle = useCallback(
    (checked: boolean) => {
      onRequiresWorkspaceChange?.(checked)
      // When turning off workspace requirement, clear the selected repo and branch
      if (!checked) {
        onRepoChange(null)
        onBranchChange(null)
      }
    },
    [onRequiresWorkspaceChange, onRepoChange, onBranchChange]
  )

  // Determine the display text
  const getDisplayText = useCallback(() => {
    if (!requiresWorkspace) {
      return t('common:repos.no_workspace_needed')
    }
    if (!selectedRepo) {
      return t('common:repos.select_repository')
    }
    if (!selectedBranch) {
      return truncateMiddle(selectedRepo.git_repo, isMobile ? 15 : 25)
    }
    const repoName = truncateMiddle(selectedRepo.git_repo, isMobile ? 10 : 15)
    const branchName = truncateMiddle(selectedBranch.name, isMobile ? 8 : 12)
    return `${repoName} / ${branchName}`
  }, [selectedRepo, selectedBranch, t, isMobile, requiresWorkspace])

  // Tooltip content
  const tooltipContent = useMemo(() => {
    if (!requiresWorkspace) {
      return t('common:repos.no_workspace_needed')
    }
    if (selectedRepo && selectedBranch) {
      return `${selectedRepo.git_repo} / ${selectedBranch.name}`
    }
    if (selectedRepo) {
      return selectedRepo.git_repo
    }
    return t('common:repos.select_repository')
  }, [selectedRepo, selectedBranch, t, requiresWorkspace])

  // Determine if selector is in "not selected" state
  // When workspace is not required, we don't show the "not selected" style
  const isNotSelected = requiresWorkspace && !selectedRepo

  // Loading state
  const isLoading = repoLoading || branchLoading

  return (
    <div className={cn('flex items-center min-w-0', className)} data-tour="unified-repo-selector">
      <Popover
        open={isOpen}
        onOpenChange={open => {
          // Prevent opening when disabled
          if (disabled && open) return
          setIsOpen(open)
        }}
      >
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <div
                  className={cn(
                    'flex items-center gap-1.5 min-w-0 rounded-full pl-2.5 pr-3 py-2.5 h-9',
                    'transition-colors cursor-pointer',
                    isNotSelected
                      ? 'border border-dashed border-border bg-muted/30 text-text-muted'
                      : 'border border-border bg-base text-text-primary hover:bg-hover',
                    isLoading ? 'animate-pulse' : '',
                    'focus:outline-none focus:ring-0',
                    (disabled || isLoading) && 'cursor-not-allowed opacity-50'
                  )}
                >
                  {requiresWorkspace ? (
                    <FolderGit2
                      className={cn(
                        'w-4 h-4 flex-shrink-0',
                        isNotSelected ? 'text-text-muted' : ''
                      )}
                    />
                  ) : (
                    <FolderX className="w-4 h-4 flex-shrink-0 text-text-muted" />
                  )}
                  {/* Embedded Toggle - show when onRequiresWorkspaceChange is provided (new chat) */}
                  {!compact && onRequiresWorkspaceChange && (
                    <>
                      <span className="text-xs text-text-primary whitespace-nowrap">
                        {t('common:repos.repository')}
                      </span>
                      <Switch
                        checked={requiresWorkspace}
                        onCheckedChange={handleRequiresWorkspaceToggle}
                        className="scale-75"
                        disabled={disabled}
                        onClick={e => e.stopPropagation()}
                      />
                    </>
                  )}
                  {/* Repository/Branch display text and chevron */}
                  {!compact && (
                    <>
                      {/* Show repo/branch text only when:
                          1. Has selected repo (show repo/branch name)
                          2. Or no toggle (hasMessages), show current state text */}
                      {(selectedRepo || !onRequiresWorkspaceChange) && (
                        <span className="truncate text-xs min-w-0">{getDisplayText()}</span>
                      )}
                      <ChevronDown className="h-2.5 w-2.5 flex-shrink-0 opacity-60" />
                    </>
                  )}
                </div>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{tooltipContent}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <PopoverContent
          className={cn(
            'p-0 w-auto min-w-[300px] max-w-[400px] border border-border bg-base',
            'shadow-xl rounded-xl overflow-hidden',
            'max-h-[var(--radix-popover-content-available-height,400px)]',
            'flex flex-col'
          )}
          align="start"
          sideOffset={4}
          collisionPadding={8}
          avoidCollisions={true}
          sticky="partial"
        >
          {/* Repository View */}
          {currentView === 'repo' && (
            <Command
              className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden"
              shouldFilter={false}
            >
              {/* Repository Selection - only show when workspace is required */}
              {requiresWorkspace ? (
                <>
                  <div className="flex items-center border-b border-border px-3 py-2">
                    <FolderGit2 className="w-4 h-4 text-text-muted mr-2" />
                    <span className="text-sm font-medium text-text-primary">
                      {t('common:repos.repository')}
                    </span>
                  </div>
                  <CommandInput
                    placeholder={t('common:branches.search_repository')}
                    onValueChange={handleSearchChange}
                    className={cn(
                      'h-9 rounded-none border-b border-border flex-shrink-0',
                      'placeholder:text-text-muted text-sm'
                    )}
                  />
                  <CommandList className="min-h-[36px] max-h-[200px] overflow-y-auto flex-1">
                    {repoError ? (
                      <div className="py-4 px-3 text-center text-sm text-error">{repoError}</div>
                    ) : repoItems.length === 0 ? (
                      <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                        {repoLoading ? 'Loading...' : t('common:branches.select_repository')}
                      </CommandEmpty>
                    ) : (
                      <>
                        <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                          {t('common:branches.no_match')}
                        </CommandEmpty>
                        <CommandGroup>
                          {repoItems.map(item => (
                            <CommandItem
                              key={item.value}
                              value={item.searchText || item.label}
                              onSelect={() => handleRepoSelect(item.value)}
                              className={cn(
                                'group cursor-pointer select-none',
                                'px-3 py-1.5 text-sm text-text-primary',
                                'rounded-md mx-1 my-[2px]',
                                'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
                                'aria-selected:bg-hover',
                                '!flex !flex-row !items-center !gap-3'
                              )}
                            >
                              <Check
                                className={cn(
                                  'h-3 w-3 shrink-0',
                                  selectedRepo?.git_repo_id.toString() === item.value
                                    ? 'opacity-100 text-primary'
                                    : 'opacity-0 text-text-muted'
                                )}
                              />
                              <span className="flex-1 min-w-0 truncate" title={item.label}>
                                {item.label}
                              </span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </>
                    )}
                  </CommandList>
                  <RepositorySelectorFooter
                    onConfigureClick={handleIntegrationClick}
                    onRefreshClick={handleRefreshCache}
                    isRefreshing={isRefreshing}
                  />
                </>
              ) : (
                /* No workspace needed - show message */
                <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                  <FolderX className="w-10 h-10 text-text-muted mb-3" />
                  <p className="text-sm text-text-muted">
                    {t('common:repos.no_workspace_description')}
                  </p>
                </div>
              )}
            </Command>
          )}

          {/* Branch View */}
          {currentView === 'branch' && (
            <Command className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden">
              <button
                type="button"
                className="flex items-center border-b border-border px-3 py-2 cursor-pointer hover:bg-hover w-full text-left"
                onClick={handleBackToRepo}
              >
                <ChevronLeft className="w-4 h-4 text-text-muted mr-1" />
                <GitBranchIcon className="w-4 h-4 text-text-muted mr-2" />
                <span className="text-sm font-medium text-text-primary">
                  {t('common:repos.branch')}
                </span>
                {selectedRepo && (
                  <span className="ml-2 text-xs text-text-muted truncate">
                    ({truncateMiddle(selectedRepo.git_repo, 20)})
                  </span>
                )}
              </button>
              <CommandInput
                placeholder={t('common:branches.search_branch')}
                className={cn(
                  'h-9 rounded-none border-b border-border flex-shrink-0',
                  'placeholder:text-text-muted text-sm'
                )}
              />
              <CommandList className="min-h-[36px] max-h-[200px] overflow-y-auto flex-1">
                {branchError ? (
                  <div className="py-4 px-3 text-center text-sm text-error">{branchError}</div>
                ) : branchItems.length === 0 ? (
                  <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                    {branchLoading ? 'Loading...' : t('common:branches.no_branch')}
                  </CommandEmpty>
                ) : (
                  <>
                    <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                      {t('common:branches.no_match')}
                    </CommandEmpty>
                    <CommandGroup>
                      {branchItems.map(item => (
                        <CommandItem
                          key={item.value}
                          value={item.searchText || item.label}
                          onSelect={() => handleBranchSelect(item.value)}
                          className={cn(
                            'group cursor-pointer select-none',
                            'px-3 py-1.5 text-sm text-text-primary',
                            'rounded-md mx-1 my-[2px]',
                            'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
                            'aria-selected:bg-hover',
                            '!flex !flex-row !items-center !gap-3'
                          )}
                        >
                          <Check
                            className={cn(
                              'h-3 w-3 shrink-0',
                              selectedBranch?.name === item.value
                                ? 'opacity-100 text-primary'
                                : 'opacity-0 text-text-muted'
                            )}
                          />
                          <span className="flex-1 min-w-0 truncate" title={item.label}>
                            {item.label}
                            {item.isDefault && (
                              <span className="ml-2 text-green-400 text-[10px]">
                                {t('common:branches.default')}
                              </span>
                            )}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}
              </CommandList>
              {/* Footer for branch view - just a divider line */}
              <div className="border-t border-border py-2 px-3 text-xs text-text-muted">
                {branches.length > 0 &&
                  `${branches.length} ${t('common:branches.select_branch').toLowerCase()}`}
              </div>
            </Command>
          )}
        </PopoverContent>
      </Popover>

      {/* Loading indicator */}
      {isSearching && (
        <Loader2 className="w-3 h-3 text-text-muted animate-spin flex-shrink-0 ml-1" />
      )}
    </div>
  )
}
