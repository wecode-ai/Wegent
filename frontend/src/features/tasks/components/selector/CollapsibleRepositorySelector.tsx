// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useRef } from 'react'
import { Folder, ChevronDown } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import RepositorySelector from './RepositorySelector'
import BranchSelector from './BranchSelector'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { GitRepoInfo, GitBranch, TaskDetail } from '@/types/api'

export interface CollapsibleRepositorySelectorProps {
  selectedRepo: GitRepoInfo | null
  setSelectedRepo: (repo: GitRepoInfo | null) => void
  selectedBranch: GitBranch | null
  setSelectedBranch: (branch: GitBranch | null) => void
  selectedTaskDetail: TaskDetail | null
  disabled?: boolean
  compact?: boolean
}

/**
 * CollapsibleRepositorySelector Component
 *
 * A collapsible container for repository and branch selectors.
 * - Collapsed: Shows only an icon with optional summary (owner/repo:branch)
 * - Expanded: Shows full repository and branch selectors
 *
 * Default state:
 * - If repo is selected: expanded
 * - If no repo selected: collapsed
 */
export function CollapsibleRepositorySelector({
  selectedRepo,
  setSelectedRepo,
  selectedBranch,
  setSelectedBranch,
  selectedTaskDetail,
  disabled = false,
  compact = false,
}: CollapsibleRepositorySelectorProps) {
  const { t } = useTranslation()

  // Smart default: expand if repo is selected, collapse otherwise
  const hasSelectedRepo = !!(selectedRepo?.git_repo || selectedTaskDetail?.git_repo)
  const [isOpen, setIsOpen] = useState(hasSelectedRepo)

  // Track previous hasSelectedRepo to detect transition (only auto-open on no-repo -> has-repo)
  const prevHasSelectedRepo = useRef(hasSelectedRepo)

  // Update open state only when transitioning from no-repo to has-repo
  useEffect(() => {
    if (hasSelectedRepo && !prevHasSelectedRepo.current) {
      setIsOpen(true)
    }
    prevHasSelectedRepo.current = hasSelectedRepo
  }, [hasSelectedRepo])

  // Generate summary text for collapsed state
  const getSummaryText = () => {
    const repoName = selectedRepo?.git_repo || selectedTaskDetail?.git_repo
    if (!repoName) return null

    const branchName =
      selectedBranch?.name || selectedTaskDetail?.branch_name || t('common:branches.default')
    // Truncate repo name if too long
    const truncatedRepo = repoName.length > 25 ? `...${repoName.slice(-22)}` : repoName
    return `${truncatedRepo}:${branchName}`
  }

  const summaryText = getSummaryText()

  // Tooltip content
  const tooltipContent = selectedRepo?.git_repo
    ? `${t('common:repos.repository_tooltip')}: ${selectedRepo.git_repo}`
    : t('common:repos.repository_tooltip')

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <CollapsibleTrigger
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2 py-1',
                'transition-colors',
                'text-text-muted hover:text-text-primary hover:bg-muted',
                'focus:outline-none focus:ring-0',
                disabled && 'cursor-not-allowed opacity-50'
              )}
              disabled={disabled}
            >
              <Folder className="h-4 w-4 flex-shrink-0" />
              {!isOpen && summaryText && (
                <span className="text-sm text-text-secondary truncate max-w-[200px]">
                  {summaryText}
                </span>
              )}
              <ChevronDown
                className={cn('h-3 w-3 transition-transform duration-200', isOpen && 'rotate-180')}
              />
            </CollapsibleTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{tooltipContent}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
        <div className="flex items-center gap-2 pt-1">
          <RepositorySelector
            selectedRepo={selectedRepo}
            handleRepoChange={setSelectedRepo}
            disabled={disabled}
            selectedTaskDetail={selectedTaskDetail}
            compact={compact}
          />
          {selectedRepo && (
            <BranchSelector
              selectedRepo={selectedRepo}
              selectedBranch={selectedBranch}
              handleBranchChange={setSelectedBranch}
              disabled={disabled}
              compact={compact}
              taskDetail={selectedTaskDetail}
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export default CollapsibleRepositorySelector
