// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useRef, useEffect } from 'react'
import { Select } from 'antd'
import { FiGithub } from 'react-icons/fi'
import { GitRepoInfo, TaskDetail } from '@/types/api'
import { useUser } from '@/features/common/UserContext'
import { useRouter } from 'next/navigation'
import Modal from '@/features/common/Modal'
import { Button } from '@headlessui/react'

interface RepositorySelectorProps {
  selectedRepo: GitRepoInfo | null
  handleRepoChange: (repo: GitRepoInfo | null) => void
  disabled: boolean
  selectedTaskDetail?: TaskDetail | null
}

import { githubApis } from '@/apis/github'

export default function RepositorySelector({
  selectedRepo,
  handleRepoChange,
  disabled,
  selectedTaskDetail
}: RepositorySelectorProps) {
  const { user } = useUser()
  const router = useRouter()
  const [repos, setRepos] = useState<GitRepoInfo[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const searchTimeout = useRef<NodeJS.Timeout | null>(null)
  // Check if user has git_info configured
  const hasGitInfo = () => {
    return user && user.git_info && user.git_info.length > 0
  }

  // 仓库加载函数，点击按钮时调用
  const handleLoadRepos = () => {
    if (!hasGitInfo()) {
      return
    }
    setLoading(true)
    setError(null)
    githubApis.getRepositories()
      .then((data) => {
        setRepos(data)
        setError(null)
        // 仅首次加载时自动选中第一个仓库
        if (data.length > 0 && !selectedRepo) {
          handleRepoChange(data[0])
        }
      })
      .catch(() => {
        setError('Failed to load repositories')
      })
      .finally(() => {
        setLoading(false)
      })
  }

  const handleSearch = (query: string) => {
    if (searchTimeout.current) {
      clearTimeout(searchTimeout.current)
    }
    if (!query) {
      // 清空搜索时恢复全部仓库
      handleLoadRepos()
      return
    }
    searchTimeout.current = setTimeout(() => {
      setLoading(true)
      githubApis.searchRepositories(query)
        .then((data) => {
          setRepos(data)
          setError(null)
        })
        .catch(() => setError('Failed to search repositories'))
        .finally(() => setLoading(false))
    }, 300)
  }

  const handleChange = (value: { value: number; label: React.ReactNode } | undefined) => {
    if (!value) {
      handleRepoChange(null)
      return
    }
    const repo = repos.find(r => r.git_repo_id === value.value)
    if (repo) {
      handleRepoChange(repo)
    }
  }

  const repoOptions = repos.map(repo => ({
    label: repo.git_repo,
    value: repo.git_repo_id,
  }))


  // 首次挂载时自动加载仓库（有 git_info 且 repos 为空）
  useEffect(() => {
    if (hasGitInfo() && repos.length === 0) {
      handleLoadRepos()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // 监听 selectedTaskDetail，自动定位仓库
  useEffect(() => {
    if (selectedTaskDetail?.git_repo) {
      // 查找仓库列表中与 git_repo 匹配的仓库对象
      const repo = repos.find(r => r.git_repo === selectedTaskDetail.git_repo)
      if (repo) {
        handleRepoChange(repo)
      }
    } else {
      handleRepoChange(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskDetail?.git_repo, repos])

  // 提取 onOpenChange 逻辑
  const handleOpenChange = (visible: boolean) => {
    if (!hasGitInfo() && visible) {
      setIsModalOpen(true)
    }
    // 仓库未加载且有 git_info，首次点开下拉时加载仓库
    if (visible && hasGitInfo() && repos.length === 0 && !loading) {
      handleLoadRepos()
    }
  }

  // 提取 onClick 逻辑
  const handleModalClick = () => {
    setIsModalOpen(false)
    router.push('/dashboard?tab=integrations')
  }

  // Git 图标独立于 Select，不再需要 renderLabel
  
  return (
    <div className="w-36 flex items-center space-x-1">
      <FiGithub className="w-3 h-3 text-gray-500 flex-shrink-0" />
      <Select
        labelInValue
        showSearch
        value={selectedRepo ? { value: selectedRepo.git_repo_id, label: selectedRepo.git_repo } : undefined}
        placeholder={
          <span className="text-sx truncate h-2">Select Repository</span>
        }
        className="w-full repository-selector"
        classNames={{ popup: { root: "repository-selector-dropdown custom-scrollbar" } }}
        disabled={disabled || loading}
        loading={loading}
        filterOption={false}
        onSearch={handleSearch}
        onChange={handleChange}
        notFoundContent={
          error ? (
            <div className="px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          ) : !loading ? (
            <div className="px-3 py-2 text-sm text-gray-400">
              {repos.length === 0 ? '请点击下拉加载仓库' : 'No repositories found'}
            </div>
          ) : null
        }
        
        options={repoOptions}
        // 禁止下拉选择和搜索（无git_info时）
        open={hasGitInfo() ? undefined : false}
        onOpenChange={handleOpenChange}
      />
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="Welcome!"
        maxWidth="sm"
      >
        <div className="flex flex-col items-center">
          <p className="text-sm text-gray-300 mb-6 text-center leading-relaxed">
            Before you can start using the app, please complete the setup below first!
          </p>
          <Button
            className="flex-1 min-w-0 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors duration-200 text-gray-900 bg-[#70a7d7] hover:bg-[#5b8bb3] focus:outline-none"
            style={{ boxShadow: 'none' }}
            onClick={handleModalClick}
          >
            Set Token
          </Button>
        </div>
      </Modal>
    </div>
  )
}