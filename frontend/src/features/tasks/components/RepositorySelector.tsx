// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useRef, useEffect } from 'react'
import { Select, App } from 'antd'
import { FiGithub } from 'react-icons/fi'
import { GitRepoInfo, TaskDetail } from '@/types/api'
import { useUser } from '@/features/common/UserContext'
import { useRouter } from 'next/navigation'
import Modal from '@/features/common/Modal'
import { Button } from 'antd'
import { paths } from '@/config/paths'
import { useTranslation } from 'react-i18next'

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
  const { message } = App.useApp()
  const { user } = useUser()
  const router = useRouter()
  const [repos, setRepos] = useState<GitRepoInfo[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  // Used antd message.error for unified error prompt, no need for local error state
  const [error, setError] = useState<string | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const searchTimeout = useRef<NodeJS.Timeout | null>(null)
  // Check if user has git_info configured
  const hasGitInfo = () => {
    return user && user.git_info && user.git_info.length > 0
  }

  // Repository loading function, called when button is clicked
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
      })
      .catch(() => {
        setError('Failed to load repositories')
        message.error('Failed to load repositories')
      })
      .finally(() => {
        setLoading(false)
      })
  }

  const handleSearch = (query: string) => {
    githubApis.searchRepositories(query)
      .then((data) => {
        setRepos(data)
        setError(null)
      })
      .catch(() => {
        setError('Failed to search repositories')
        message.error('Failed to search repositories')
      })
      .finally(() => setLoading(false))
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

  // Listen to selectedTaskDetail, auto-locate repository
  useEffect(() => {
    let canceled = false

    const tryLocateRepo = async () => {
      if (selectedTaskDetail?.git_repo) {
        // First, try to find in existing list
        const repo = repos.find(r => r.git_repo === selectedTaskDetail.git_repo)
        if (repo) {
          handleRepoChange(repo)
          return
        }
        // Fallback: precise search via fullmatch when not found locally
        try {
          setLoading(true)
          const result = await githubApis.searchRepositories(selectedTaskDetail.git_repo, { fullmatch: true })
          if (canceled) return
          if (result && result.length > 0) {
            const matched = result.find(r => r.git_repo === selectedTaskDetail.git_repo) ?? result[0]
            handleRepoChange(matched)
            setError(null)
          } else {
            message.error('No repositories found')
          }
        } catch {
          setError('Failed to search repositories')
          message.error('Failed to search repositories')
        } finally {
          if (!canceled) setLoading(false)
        }
      } else {
        handleRepoChange(null)
      }
    }

    tryLocateRepo()
    return () => {
      canceled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskDetail?.git_repo, repos])

  // Extract onOpenChange logic
  // load git repositories on first open
  const handleOpenChange = (visible: boolean) => {
    if (!hasGitInfo() && visible) {
      setIsModalOpen(true)
    }
    // If repository not loaded and git_info exists, load repositories on first dropdown open
    // fisrt click
    if (visible && repos.length == 0 && hasGitInfo() && !loading) {
      handleLoadRepos()
      return
    }
  }

  // Extract onClick logic
  const handleModalClick = () => {
    setIsModalOpen(false)
    router.push(paths.settings.integrations.getHref())
  }

  const { t } = useTranslation()

  return (
    <div className="flex items-center space-x-1 min-w-0">
      <FiGithub className="w-3 h-3 text-text-muted flex-shrink-0" />
      <Select
        labelInValue
        showSearch
        allowClear
        value={selectedRepo ? { value: selectedRepo.git_repo_id, label: selectedRepo.git_repo } : undefined}
        placeholder={
          <span className="text-sx truncate h-2">{t('branches.select_repository')}</span>
        }
        className="repository-selector min-w-0 truncate"
        style={{ width: 'auto', maxWidth: 200, display: 'inline-block', paddingRight: 8 }}
        popupMatchSelectWidth={false}
        styles={{ popup: { root: { maxWidth: 200 } } }}
        classNames={{ popup: { root: "repository-selector-dropdown custom-scrollbar" } }}
        disabled={disabled}
        loading={loading}
        filterOption={false}
        onSearch={handleSearch}
        onChange={handleChange}
        notFoundContent={
          error ? (
            <div className="px-3 py-2 text-sm" style={{ color: 'rgb(var(--color-error))' }}>
              {error}
              {/* antd message.error is globally prompted */}
            </div>
          ) : !loading ? (
            <div className="px-3 py-2 text-sm text-text-muted">
              {repos.length === 0 ? 'Select Repository' : 'No repositories found'}
            </div>
          ) : null
        }
        options={repoOptions}
        // Disable dropdown selection and search (when no git_info)
        open={hasGitInfo() ? undefined : false}
        onOpenChange={handleOpenChange}
        onClear={handleLoadRepos}
      />
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={t('guide.title')}
        maxWidth="sm"
      >
        <div className="flex flex-col items-center">
          <p className="text-sm text-text-secondary mb-6 text-center leading-relaxed">
            {t('guide.description')}
          </p>
          <Button
            type="primary"
            size="small"
            onClick={handleModalClick}
            style={{ minWidth: '100px' }}
          >
            {t('branches.set_token')}
          </Button>
        </div>
      </Modal>
    </div>
  )
}
