// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useRef } from 'react'
import { Select, App } from 'antd'
import { FiGitBranch } from 'react-icons/fi'
import { GitRepoInfo, GitBranch } from '@/types/api'
import { githubApis } from '@/apis/github'
import { useTranslation } from '@/hooks/useTranslation'

/**
 * BranchSelector component
 * Refer to RepositorySelector, internally fetches branch data, unified loading/empty/error states
 */
interface BranchSelectorProps {
  selectedRepo: GitRepoInfo | null
  selectedBranch: GitBranch | null
  handleBranchChange: (branch: GitBranch | null) => void
  disabled: boolean
}

import { useTaskContext } from '../contexts/taskContext'

export default function BranchSelector({
  selectedRepo,
  selectedBranch,
  handleBranchChange,
  disabled
}: BranchSelectorProps) {
  const { t } = useTranslation('common')
  const { message } = App.useApp()
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [loading, setLoading] = useState<boolean>(false)
      // Used antd message.error for unified error prompt, no need for local error state
  const [error, setError] = useState<string | null>(null)
  const [userCleared, setUserCleared] = useState(false)
  const { selectedTaskDetail } = useTaskContext()

      // antd Select does not need dropdownDirection
  const selectRef = useRef(null)

  // Fetch branch list
  useEffect(() => {
    if (!selectedRepo) {
      setBranches([])
      setError(null)
      setLoading(false)
      return
    }
    let ignore = false
    setLoading(true)
    githubApis.getBranches(selectedRepo)
      .then((data) => {
        if (!ignore) {
          setBranches(data)
          setError(null)
          setUserCleared(false)
        }
      })
      .catch((err) => {
        if (!ignore) {
          setError(t('branches.load_failed'))
          message.error(t('branches.load_failed'))
        }
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => { ignore = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepo])

  // Automatically set branch based on selectedTask
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
    // If there is no selectedTask or not found, select the default branch by default
    if (!selectedBranch) {
      const defaultBranch = branches.find(b => b.default)
      if (defaultBranch) {
        handleBranchChange(defaultBranch)
      } else if (branches.length > 0) {
        // Fallback to first branch if no default branch found
        handleBranchChange(branches[0])
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskDetail, branches, userCleared])

  useEffect(() => {
    setUserCleared(false)
  }, [selectedRepo, selectedTaskDetail?.branch_name])

      // State merging
  const showLoading = loading
  const showError = !!error
  const showNoBranch = !showLoading && !showError && branches.length === 0

      // Do not render (no branches, no selection, and no loading/error)
  if (!selectedBranch && branches.length === 0 && !showLoading && !showError) return null

      // Construct branch options
  const branchOptions = branches.map(branch => ({
    label: (
      <span>
        {branch.name}
        {branch.default && (
          <span className="ml-2 text-green-400 text-[10px]">{t('branches.default')}</span>
        )}
      </span>
    ),
    value: branch.name,
  }))

  // antd Select onChange
  const handleChange = (value: { value: string; label: React.ReactNode } | undefined) => {
    if (!value) {
      setUserCleared(true)
      handleBranchChange(null)
      return
    }
    const branch = branches.find(b => b.name === value.value)
    if (branch) {
      setUserCleared(false)
      handleBranchChange(branch)
    }
  }

  return (
    <div className="flex items-center space-x-1 min-w-0">
      <FiGitBranch className={`w-3 h-3 text-text-muted flex-shrink-0 ${showLoading ? 'animate-pulse' : ''}`} />
      <Select
        labelInValue
        showSearch
        value={selectedBranch ? { value: selectedBranch.name, label: selectedBranch.name + (selectedBranch.default ? ' (default)' : '') } : undefined}
        placeholder={
          <span className="text-sx truncate h-2">{t('branches.select_branch')}</span>
        }
        className="repository-selector min-w-0 truncate"
        style={{ width: 'auto', maxWidth: 200, display: 'inline-block', paddingRight: 8 }}
        popupMatchSelectWidth={false}
        styles={{ popup: { root: { maxWidth: 200 } } }}
        classNames={{ popup: { root: "repository-selector-dropdown custom-scrollbar" } }}
        disabled={disabled || showLoading || showError || showNoBranch}
        loading={showLoading}
        optionFilterProp="value"
        filterOption={(input, option) => {
          const normalizedInput = input.trim().toLowerCase()
          if (!normalizedInput) return true
          const optionValue = typeof option?.value === 'string' ? option.value : ''
          const optionLabel = typeof option?.label === 'string' ? option.label : ''
          const haystack = `${optionValue} ${optionLabel}`.toLowerCase()
          return haystack.includes(normalizedInput)
        }}
        onChange={handleChange}
        notFoundContent={
          showLoading ? (
            <div className="px-3 py-2 text-sm text-text-muted flex items-center">
              <FiGitBranch className="w-4 h-4 animate-pulse mr-2" />
              {t('branches.loading')}
            </div>
          ) : showError ? (
            <div className="px-3 py-2 text-sm" style={{ color: 'rgb(var(--color-error))' }}>
              <FiGitBranch className="w-4 h-4 mr-2" />
              {error}
              {/* antd message.error is globally prompted */}
            </div>
          ) : showNoBranch ? (
            <div className="px-3 py-2 text-sm text-text-muted">
              {t('branches.no_branch')}
            </div>
          ) : null
        }
        options={branchOptions}
      />
    </div>
  )
}
