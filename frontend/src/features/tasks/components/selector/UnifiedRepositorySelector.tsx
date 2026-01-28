// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import * as React from 'react'
import { useState, useEffect, useMemo, useCallback, useContext, useRef } from 'react'
import { ChevronDown, Loader2, GitBranch as GitBranchIcon, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { cn } from '@/lib/utils'
import { paths } from '@/config/paths'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

import { truncateMiddle } from '@/utils/stringUtils'
import { GitRepoInfo, GitBranch, TaskDetail } from '@/types/api'
import { githubApis } from '@/apis/github'
import { useToast } from '@/hooks/use-toast'
import { useRepositorySearch } from '../../hooks/useRepositorySearch'
import { RepoListView } from './RepoListView'
import { BranchListView } from './BranchListView'
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
 * Animation variants for drill-down transitions
 */
const slideVariants = {
  enterFromRight: {
    x: 20,
    opacity: 0,
  },
  enterFromLeft: {
    x: -20,
    opacity: 0,
  },
  center: {
    x: 0,
    opacity: 1,
  },
  exitToLeft: {
    x: -40,
    opacity: 0,
  },
  exitToRight: {
    x: 40,
    opacity: 0,
  },
}

/**
 * Spring transition for smooth, iOS-like animations
 */
const slideTransition = {
  type: 'spring' as const,
  stiffness: 400,
  damping: 30,
  mass: 0.8,
}

/**
 * UnifiedRepositorySelector component
 * Provides unified repository and branch selection in a single Popover
 * with smooth drill-down animations and skeleton loading
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
  // Track slide direction for animations
  const [slideDirection, setSlideDirection] = useState<'left' | 'right'>('left')

  // Branch state
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)
  const [userCleared, setUserCleared] = useState(false)

  // Track previous requiresWorkspace value to detect changes (e.g., team switch)
  const prevRequiresWorkspaceRef = useRef(requiresWorkspace)

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

  // Convert branches to items - sort default branch first
  const branchItems = useMemo(() => {
    const sorted = [...branches].sort((a, b) => {
      if (a.default && !b.default) return -1
      if (!a.default && b.default) return 1
      return 0
    })
    return sorted.map(branch => ({
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

  // Set initial view when popover opens based on selection state
  useEffect(() => {
    if (isOpen) {
      // If repo is already selected, start with branch view for quick branch switching
      if (selectedRepo) {
        setSlideDirection('left')
        setCurrentView('branch')
      } else {
        setCurrentView('repo')
      }
    }
  }, [isOpen, selectedRepo])

  // Auto-open popover when requiresWorkspace changes from false to true (e.g., team switch)
  // and no repo is currently selected
  useEffect(() => {
    const prevValue = prevRequiresWorkspaceRef.current
    prevRequiresWorkspaceRef.current = requiresWorkspace

    // If changed from false to true and no repo selected, auto-open
    if (!prevValue && requiresWorkspace && !selectedRepo) {
      setTimeout(() => {
        setIsOpen(true)
      }, 100)
    }
  }, [requiresWorkspace, selectedRepo])

  // Navigate to settings page
  const handleIntegrationClick = () => {
    router.push(paths.settings.integrations.getHref())
    setIsOpen(false)
  }

  // Handle repo selection - drill into branch view
  const handleRepoSelect = useCallback(
    (value: string) => {
      // If workspace was disabled, re-enable it when user selects a repo
      if (!requiresWorkspace && onRequiresWorkspaceChange) {
        onRequiresWorkspaceChange(true)
      }

      handleRepoSelectFromSearch(value)
      // Set direction for slide animation
      setSlideDirection('left')
      // After selecting repo, automatically switch to branch view
      setCurrentView('branch')
    },
    [handleRepoSelectFromSearch, requiresWorkspace, onRequiresWorkspaceChange]
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
    setSlideDirection('right')
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
      } else {
        // When turning on workspace requirement, auto-open the popover
        // Use setTimeout to ensure the toggle animation completes first
        setTimeout(() => {
          setIsOpen(true)
        }, 100)
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
                    'group flex items-center gap-1.5 min-w-0 rounded-full pl-2.5 pr-3 py-2.5 h-9',
                    'transition-all duration-200 cursor-pointer',
                    // When workspace is required but not selected - show error state like ModelSelector
                    requiresWorkspace && isNotSelected
                      ? 'border border-error text-error bg-error/5 hover:bg-error/10'
                      : 'border border-border bg-base text-text-primary hover:bg-hover',
                    isLoading ? 'animate-pulse' : '',
                    'focus:outline-none focus:ring-0',
                    (disabled || isLoading) && 'cursor-not-allowed opacity-50'
                  )}
                >
                  <GitBranchIcon
                    className={cn(
                      'w-4 h-4 flex-shrink-0 transition-colors opacity-100',
                      // When workspace required but not selected - show error
                      requiresWorkspace && isNotSelected ? 'text-error' : 'text-text-primary'
                    )}
                  />
                  {/* Repository/Branch display text and chevron */}
                  {!compact && (
                    <>
                      {selectedRepo && (
                        <span className="truncate text-xs min-w-0">{getDisplayText()}</span>
                      )}

                      {/* Show Chevron by default, but show X on hover if we can clear */}
                      <div className="flex items-center">
                        {selectedRepo && onRequiresWorkspaceChange ? (
                          <>
                            <ChevronDown className="h-2.5 w-2.5 flex-shrink-0 opacity-60 group-hover:hidden" />
                            <div
                              role="button"
                              tabIndex={0}
                              className="hidden group-hover:flex items-center justify-center h-4 w-4 rounded-full hover:bg-hover text-text-muted hover:text-text-primary transition-colors"
                              onClick={e => {
                                e.stopPropagation()
                                handleRequiresWorkspaceToggle(false)
                              }}
                            >
                              <X className="h-3 w-3" />
                            </div>
                          </>
                        ) : (
                          <ChevronDown className="h-2.5 w-2.5 flex-shrink-0 opacity-60" />
                        )}
                      </div>
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
          {/* Loading progress bar */}
          {(branchLoading || isSearching) && (
            <div className="absolute top-0 left-0 right-0 h-[2px] bg-muted overflow-hidden z-10">
              <motion.div
                className="h-full bg-primary"
                initial={{ x: '-100%', width: '30%' }}
                animate={{ x: '400%' }}
                transition={{
                  duration: 1,
                  repeat: Infinity,
                  ease: 'linear',
                }}
              />
            </div>
          )}

          <AnimatePresence mode="wait" initial={false}>
            {/* Repository View */}
            {currentView === 'repo' && (
              <motion.div
                key="repo-view"
                initial={slideDirection === 'right' ? 'enterFromLeft' : 'center'}
                animate="center"
                exit="exitToLeft"
                variants={slideVariants}
                transition={slideTransition}
                className="flex flex-col flex-1 min-h-0"
              >
                <RepoListView
                  repos={repoItems}
                  selectedRepoId={selectedRepo?.git_repo_id.toString() ?? null}
                  onSelect={handleRepoSelect}
                  onSearchChange={handleSearchChange}
                  onConfigureClick={handleIntegrationClick}
                  onRefreshClick={handleRefreshCache}
                  isLoading={repoLoading}
                  isSearching={isSearching}
                  isRefreshing={isRefreshing}
                  error={repoError}
                  onClearSelection={
                    // Only show clear button if we have a way to toggle workspace requirement
                    // And currently workspace IS required (so we can clear it)
                    onRequiresWorkspaceChange && requiresWorkspace
                      ? () => handleRequiresWorkspaceToggle(false)
                      : undefined
                  }
                />
              </motion.div>
            )}

            {/* Branch View */}
            {currentView === 'branch' && (
              <motion.div
                key="branch-view"
                initial="enterFromRight"
                animate="center"
                exit="exitToRight"
                variants={slideVariants}
                transition={slideTransition}
                className="flex flex-col flex-1 min-h-0"
              >
                <BranchListView
                  branches={branchItems}
                  selectedBranchName={selectedBranch?.name ?? null}
                  repoName={selectedRepo?.git_repo ?? ''}
                  branchCount={branches.length}
                  onSelect={handleBranchSelect}
                  onBack={handleBackToRepo}
                  isLoading={branchLoading}
                  error={branchError}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </PopoverContent>
      </Popover>

      {/* Loading indicator */}
      {isSearching && (
        <Loader2 className="w-3 h-3 text-text-muted animate-spin flex-shrink-0 ml-1" />
      )}
    </div>
  )
}
