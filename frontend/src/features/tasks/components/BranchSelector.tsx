// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { Listbox } from '@headlessui/react'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import { FiGitBranch } from 'react-icons/fi'
import { GitRepoInfo, GitBranch } from '@/types/api'
import { githubApis } from '@/apis/github'

/**
 * BranchSelector 组件
 * 参考 RepositorySelector，内部拉取分支数据，统一 loading/empty/error 状态
 */
interface BranchSelectorProps {
  selectedRepo: GitRepoInfo | null
  selectedBranch: GitBranch | null
  handleBranchChange: (branch: GitBranch) => void
  disabled: boolean
}

import { useTaskContext } from '../contexts/taskContext'

export default function BranchSelector({
  selectedRepo,
  selectedBranch,
  handleBranchChange,
  disabled
}: BranchSelectorProps) {
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const { selectedTask } = useTaskContext()

  // 下拉展开方向
  const [dropdownDirection, setDropdownDirection] = useState<'up' | 'down'>('down')
  const buttonRef = useRef<HTMLButtonElement>(null)

  // 计算下拉展开方向
  const handleDropdownClick = () => {
    if (!buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    if (spaceBelow < 100 && spaceAbove > spaceBelow) {
      setDropdownDirection('up')
    } else {
      setDropdownDirection('down')
    }
  }

  // 拉取分支列表
  useEffect(() => {
    if (!selectedRepo) {
      setBranches([])
      setError(null)
      setLoading(false)
      return
    }
    let ignore = false
    setLoading(true)
    githubApis.getBranches(selectedRepo.git_repo)
      .then((data) => {
        if (!ignore) {
          setBranches(data)
          setError(null)
        }
      })
      .catch((err) => {
        if (!ignore) setError('Failed to load branches')
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => { ignore = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepo])

  // 自动根据 selectedTask 设置分支
  useEffect(() => {
    if (!branches || branches.length === 0) return
    if (
      selectedTask &&
      'branch_name' in selectedTask &&
      selectedTask.branch_name
    ) {
      const foundBranch = branches.find(b => b.name === selectedTask.branch_name) || null
      if (foundBranch) {
        handleBranchChange(foundBranch)
        return
      }
    }
    // 如果没有 selectedTask 或找不到，默认选中第一个
    if (!selectedBranch) {
      handleBranchChange(branches[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTask, branches])

  // 状态合并
  const showLoading = loading
  const showError = !!error
  const showNoBranch = !showLoading && !showError && branches.length === 0

  // 没有选中项且无分支时不渲染
  if (!selectedBranch && branches.length === 0 && !showLoading && !showError) return null

  return (
    <Listbox
      value={selectedBranch}
      onChange={handleBranchChange}
      disabled={disabled || showLoading || showError || showNoBranch}
    >
      <div className="relative">
        <Listbox.Button
          ref={buttonRef}
          className={`flex items-center space-x-1 text-gray-500 hover:text-gray-400 w-full ${disabled || showLoading || showError || showNoBranch ? 'opacity-50 cursor-not-allowed' : ''}`}
          onClick={handleDropdownClick}
        >
          <FiGitBranch className={`w-3 h-3 flex-shrink-0 ${showLoading ? 'animate-pulse' : ''}`} />
          <span className="text-sm truncate max-w-[100px]" title={selectedBranch?.name || ''}>
            {showLoading
              ? 'Loading...'
              : showError
                ? '加载失败'
                : showNoBranch
                  ? 'No branches'
                  : selectedBranch?.name}
          </span>
          <ChevronDownIcon className="w-4 h-4 flex-shrink-0" />
        </Listbox.Button>
        <Listbox.Options
          className={`absolute ${dropdownDirection === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'} left-0 bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl z-20 min-w-full w-auto max-w-[220px] py-1 max-h-[300px] overflow-y-auto custom-scrollbar`}
        >
          {/* 状态提示和分支列表 */}
          {showLoading && (
            <div className="px-3 py-2 text-sm text-gray-400 flex items-center">
              <FiGitBranch className="w-4 h-4 animate-pulse mr-2" />
              Loading branches...
            </div>
          )}
          {showError && (
            <div className="px-3 py-2 text-sm text-red-400 flex items-center">
              <FiGitBranch className="w-4 h-4 mr-2" />
              {error}
            </div>
          )}
          {showNoBranch && (
            <div className="px-3 py-2 text-sm text-gray-400">
              No branches found
            </div>
          )}
          {!showLoading && !showError && branches.length > 0 && (
            branches.map((branch) => (
              <Listbox.Option
                key={branch.name}
                value={branch}
                className="px-2.5 py-1.5 text-xs text-white hover:bg-[#21262d] cursor-pointer block truncate"
                title={branch.name}
              >
                {branch.name}
                {branch.default && (
                  <span className="ml-2 text-green-400 text-[10px]">(default)</span>
                )}
              </Listbox.Option>
            ))
          )}
        </Listbox.Options>
      </div>
    </Listbox>
  )
}