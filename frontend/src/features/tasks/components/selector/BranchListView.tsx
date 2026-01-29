// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import * as React from 'react'
import { Check, ChevronLeft, GitBranch as GitBranchIcon } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Branch item for display
 */
export interface BranchItem {
  value: string
  label: string
  searchText: string
  isDefault?: boolean
}

/**
 * Props for BranchListView component
 */
export interface BranchListViewProps {
  /** List of branches to display */
  branches: BranchItem[]
  /** Currently selected branch name */
  selectedBranchName: string | null
  /** Name of the selected repository */
  repoName: string
  /** Total count of branches */
  branchCount: number
  /** Callback when a branch is selected */
  onSelect: (branchName: string) => void
  /** Callback when back button is clicked */
  onBack: () => void
  /** Whether the branch list is loading */
  isLoading: boolean
  /** Error message to display */
  error: string | null
}

/**
 * Skeleton loader for branch list
 */
function BranchListSkeleton() {
  return (
    <div className="p-2 space-y-2">
      <Skeleton className="h-8 w-full rounded-md" />
      <Skeleton className="h-8 w-4/5 rounded-md" />
      <Skeleton className="h-8 w-3/4 rounded-md" />
    </div>
  )
}

/**
 * BranchListView - Branch list view component
 *
 * Displays a searchable list of branches with a back button,
 * loading states, and error handling.
 */
export function BranchListView({
  branches,
  selectedBranchName,
  repoName,
  branchCount,
  onSelect,
  onBack,
  isLoading,
  error,
}: BranchListViewProps) {
  const { t } = useTranslation()

  return (
    <Command className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Breadcrumb header showing selected repo */}
      <button
        type="button"
        className="flex items-center border-b border-border px-3 py-2 cursor-pointer hover:bg-hover w-full text-left group"
        onClick={onBack}
      >
        <ChevronLeft className="w-4 h-4 text-text-muted mr-1 group-hover:text-primary transition-colors flex-shrink-0" />
        <GitBranchIcon className="w-4 h-4 text-text-muted mr-2 flex-shrink-0" />
        <span className="text-sm font-medium text-text-primary flex-shrink-0">
          {t('common:repos.branch')}
        </span>
        {repoName && (
          <span
            className="ml-2 text-xs text-text-muted truncate flex-1 text-right"
            title={repoName}
          >
            {repoName}
          </span>
        )}
      </button>

      {/* Search Input */}
      <CommandInput
        placeholder={t('common:branches.search_branch')}
        className={cn(
          'h-9 rounded-none border-b border-border flex-shrink-0',
          'placeholder:text-text-muted text-sm'
        )}
      />

      {/* Branch List */}
      <CommandList className="min-h-[36px] max-h-[200px] overflow-y-auto flex-1">
        {error ? (
          <div className="py-4 px-3 text-center text-sm text-error">{error}</div>
        ) : isLoading ? (
          <BranchListSkeleton />
        ) : branches.length === 0 ? (
          <CommandEmpty className="py-4 text-center text-sm text-text-muted">
            {t('common:branches.no_branch')}
          </CommandEmpty>
        ) : (
          <>
            <CommandEmpty className="py-4 text-center text-sm text-text-muted">
              {t('common:branches.no_match')}
            </CommandEmpty>
            <CommandGroup>
              {branches.map(item => (
                <CommandItem
                  key={item.value}
                  value={item.searchText || item.label}
                  onSelect={() => onSelect(item.value)}
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
                      selectedBranchName === item.value
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

      {/* Footer */}
      <div className="border-t border-border py-2 px-3 text-xs text-text-muted">
        {branchCount > 0 && `${branchCount} ${t('common:branches.select_branch').toLowerCase()}`}
      </div>
    </Command>
  )
}
