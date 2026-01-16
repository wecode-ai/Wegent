// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect } from 'react'
import { Folder, ChevronDown } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import MobileRepositorySelector from './MobileRepositorySelector'
import MobileBranchSelector from './MobileBranchSelector'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { GitRepoInfo, GitBranch as GitBranchType, TaskDetail } from '@/types/api'

export interface MobileCollapsibleRepositorySelectorProps {
  selectedRepo: GitRepoInfo | null
  setSelectedRepo: (repo: GitRepoInfo | null) => void
  selectedBranch: GitBranchType | null
  setSelectedBranch: (branch: GitBranchType | null) => void
  selectedTaskDetail: TaskDetail | null
  disabled?: boolean
}

/**
 * MobileCollapsibleRepositorySelector Component
 *
 * A mobile-optimized collapsible container for repository and branch selectors.
 * Designed for touch interactions with 44px minimum touch targets.
 *
 * Behavior:
 * - Collapsed: Shows folder icon with repo:branch summary
 * - Expanded: Shows full repository and branch selector rows
 *
 * Smart default:
 * - Expanded if repo is selected
 * - Collapsed if no repo selected
 */
export function MobileCollapsibleRepositorySelector({
  selectedRepo,
  setSelectedRepo,
  selectedBranch,
  setSelectedBranch,
  selectedTaskDetail,
  disabled = false,
}: MobileCollapsibleRepositorySelectorProps) {
  const { t } = useTranslation()

  // Smart default: expand if repo is selected, collapse otherwise
  const hasSelectedRepo = !!(selectedRepo?.git_repo || selectedTaskDetail?.git_repo)
  const [isOpen, setIsOpen] = useState(hasSelectedRepo)

  // Update open state when repo selection changes
  useEffect(() => {
    if (hasSelectedRepo && !isOpen) {
      setIsOpen(true)
    }
  }, [hasSelectedRepo, isOpen])

  // Generate summary text for collapsed state
  const getSummaryText = () => {
    const repoName = selectedRepo?.git_repo || selectedTaskDetail?.git_repo
    if (!repoName) return t('common:repos.repository')

    const branchName = selectedBranch?.name || selectedTaskDetail?.branch_name || 'default'
    // Truncate repo name for mobile
    const truncatedRepo = repoName.length > 18 ? `...${repoName.slice(-15)}` : repoName
    return `${truncatedRepo}:${branchName}`
  }

  const summaryText = getSummaryText()

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="w-full">
      <CollapsibleTrigger
        className={cn(
          'w-full flex items-center justify-between px-3 py-2.5',
          'text-left transition-colors',
          'hover:bg-hover active:bg-hover',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
        disabled={disabled}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Folder className="h-4 w-4 text-text-muted flex-shrink-0" />
          <span className="text-sm truncate">{summaryText}</span>
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-text-muted flex-shrink-0 transition-transform duration-200',
            isOpen && 'rotate-180'
          )}
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0">
        <div className="border-t border-border">
          <MobileRepositorySelector
            selectedRepo={selectedRepo}
            handleRepoChange={setSelectedRepo}
            disabled={disabled}
            selectedTaskDetail={selectedTaskDetail}
          />
          {selectedRepo && (
            <MobileBranchSelector
              selectedRepo={selectedRepo}
              selectedBranch={selectedBranch}
              handleBranchChange={setSelectedBranch}
              disabled={disabled}
              taskDetail={selectedTaskDetail}
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export default MobileCollapsibleRepositorySelector
