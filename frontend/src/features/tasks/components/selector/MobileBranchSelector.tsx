// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useMemo, useContext } from 'react'
import { GitBranch, Check } from 'lucide-react'
import { GitRepoInfo, GitBranch as GitBranchType, TaskDetail } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { githubApis } from '@/apis/github'
import { useToast } from '@/hooks/use-toast'
import { TaskContext } from '../../contexts/taskContext'
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

interface MobileBranchSelectorProps {
  selectedRepo: GitRepoInfo | null
  selectedBranch: GitBranchType | null
  handleBranchChange: (branch: GitBranchType | null) => void
  disabled: boolean
  taskDetail?: TaskDetail | null
}

/**
 * Mobile-specific Branch Selector
 * Renders as a full-width clickable row that opens a popover
 */
export default function MobileBranchSelector({
  selectedRepo,
  selectedBranch,
  handleBranchChange,
  disabled,
  taskDetail,
}: MobileBranchSelectorProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [branches, setBranches] = useState<GitBranchType[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [userCleared, setUserCleared] = useState(false)
  const [open, setOpen] = useState(false)

  const taskContext = useContext(TaskContext)
  const selectedTaskDetail = taskDetail ?? taskContext?.selectedTaskDetail ?? null

  // Fetch branch list
  useEffect(() => {
    handleBranchChange(null)
    if (!selectedRepo) {
      setBranches([])
      setError(null)
      setLoading(false)
      return
    }
    let ignore = false
    setLoading(true)
    githubApis
      .getBranches(selectedRepo)
      .then(data => {
        if (!ignore) {
          setBranches(data)
          setError(null)
          setUserCleared(false)
        }
      })
      .catch(() => {
        if (!ignore) {
          setError(t('common:branches.load_failed'))
          toast({
            variant: 'destructive',
            title: t('common:branches.load_failed'),
          })
        }
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepo])

  // Auto-select branch based on task
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
        handleBranchChange(foundBranch)
        return
      }
    }
    if (!selectedBranch) {
      const defaultBranch = branches.find(b => b.default)
      if (defaultBranch) {
        handleBranchChange(defaultBranch)
      } else {
        handleBranchChange(null)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskDetail, branches, userCleared])

  useEffect(() => {
    setUserCleared(false)
  }, [selectedRepo, selectedTaskDetail?.branch_name])

  const showLoading = loading
  const showError = !!error
  const showNoBranch = !showLoading && !showError && branches.length === 0

  const selectItems = useMemo(() => {
    return branches.map(branch => ({
      value: branch.name,
      label: branch.name,
      isDefault: branch.default,
    }))
  }, [branches])

  // Don't render if no repo selected
  if (!selectedRepo) return null

  const handleChange = (value: string) => {
    const branch = branches.find(b => b.name === value)
    if (branch) {
      setUserCleared(false)
      handleBranchChange(branch)
      setOpen(false)
    }
  }

  const displayValue = selectedBranch
    ? `${selectedBranch.name}${selectedBranch.default ? ' (default)' : ''}`
    : '未选择'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled || showError || showNoBranch || showLoading}
          className={cn(
            'w-full flex items-center justify-between px-3 py-2.5',
            'text-left transition-colors',
            'hover:bg-hover active:bg-hover',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            showLoading && 'animate-pulse'
          )}
        >
          <div className="flex items-center gap-3">
            <GitBranch className="h-4 w-4 text-text-muted" />
            <span className="text-sm">分支</span>
          </div>
          <span className="text-sm text-text-muted truncate max-w-[140px]">{displayValue}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          'p-0 w-[260px] border border-border bg-base',
          'shadow-xl rounded-xl overflow-hidden',
          'max-h-[400px] flex flex-col'
        )}
        align="end"
        side="top"
        sideOffset={4}
      >
        <Command className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden">
          <CommandInput
            placeholder={t('common:branches.search_branch')}
            className="h-9 rounded-none border-b border-border flex-shrink-0 placeholder:text-text-muted text-sm"
          />
          <CommandList className="min-h-[36px] max-h-[200px] overflow-y-auto flex-1">
            {showError ? (
              <div className="py-4 px-3 text-center text-sm text-error">{error}</div>
            ) : selectItems.length === 0 ? (
              <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                {showLoading
                  ? 'Loading...'
                  : showNoBranch
                    ? t('common:branches.no_branch')
                    : t('common:branches.select_branch')}
              </CommandEmpty>
            ) : (
              <>
                <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                  {t('common:branches.no_match')}
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
                          selectedBranch?.name === item.value
                            ? 'opacity-100 text-primary'
                            : 'opacity-0'
                        )}
                      />
                      <span className="flex-1 min-w-0 truncate">
                        {item.label}
                        {item.isDefault && (
                          <span className="ml-2 text-green-500 text-[10px]">
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
        </Command>
      </PopoverContent>
    </Popover>
  )
}
