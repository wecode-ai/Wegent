// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { buildChatCodeHref } from '@/config/coding-route'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { taskApis, TaskShareInfo } from '@/apis/tasks'
import { githubApis } from '@/apis/github'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import Modal from '@/features/common/Modal'
import RepositorySelector from '../selector/RepositorySelector'
import BranchSelector from '../selector/BranchSelector'
import type { GitRepoInfo, GitBranch } from '@/types/api'

interface TaskShareHandlerProps {
  onTaskCopied?: () => void
}

/**
 * Handle task sharing URL parameter detection, copy logic, and modal display
 */
export default function TaskShareHandler({ onTaskCopied }: TaskShareHandlerProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { user } = useUser()
  const searchParams = useSearchParams()
  const router = useRouter()

  const [shareInfo, setShareInfo] = useState<TaskShareInfo | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [_isLoading, setIsLoading] = useState(false)
  const [isCopying, setIsCopying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Repository and branch selection for code tasks
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<GitBranch | null>(null)

  const isSelfShare = shareInfo && user && shareInfo.user_id === user.id
  const isCodeTask = shareInfo?.task_type === 'code'
  const isRepoSelectionRequired = isCodeTask && (!selectedRepo || !selectedBranch)

  const cleanupUrlParams = React.useCallback(() => {
    const url = new URL(window.location.href)
    url.searchParams.delete('taskShare')
    router.replace(url.pathname + url.search)
  }, [router])

  useEffect(() => {
    const taskShareToken = searchParams.get('taskShare')

    if (!taskShareToken) {
      return
    }

    const fetchShareInfo = async () => {
      setIsLoading(true)
      try {
        const info = await taskApis.getTaskShareInfo(taskShareToken)
        setShareInfo(info)
        setIsModalOpen(true)
      } catch (err) {
        console.error('Failed to fetch task share info:', err)
        toast({
          variant: 'destructive',
          title: t('shared-task:handler_load_failed'),
          description: (err as Error)?.message || t('common:messages.unknown_error'),
        })
        cleanupUrlParams()
      } finally {
        setIsLoading(false)
      }
    }

    fetchShareInfo()
  }, [searchParams, toast, t, cleanupUrlParams])

  // Auto-fill repository and branch for code tasks
  useEffect(() => {
    if (!shareInfo || !isCodeTask) {
      return
    }

    // Need at least git_repo_id and git_type to identify a repository
    if (!shareInfo.git_repo_id || !shareInfo.git_type) {
      return
    }

    const autoFillRepo = async () => {
      try {
        // Load all repositories
        const repos = await githubApis.getRepositories()

        // Find the repository by matching multiple fields for precision
        // Priority: git_repo_id + git_domain + git_type > git_repo_id + git_type
        const matchedRepo = repos.find(repo => {
          // Must match git_repo_id and git_type
          const idMatch = repo.git_repo_id === shareInfo.git_repo_id
          const typeMatch = repo.type === shareInfo.git_type

          if (!idMatch || !typeMatch) {
            return false
          }

          // Additionally match git_domain if available
          if (shareInfo.git_domain) {
            return repo.git_domain === shareInfo.git_domain
          }

          // Additionally match git_repo (owner/repo) if available
          if (shareInfo.git_repo) {
            return repo.git_repo === shareInfo.git_repo
          }

          return true
        })

        if (matchedRepo) {
          // Only set the repository, let BranchSelector handle branch loading and selection
          // BranchSelector will use tempTaskDetail.branch_name to auto-select the branch
          setSelectedRepo(matchedRepo)
        }
      } catch (error) {
        console.error('Failed to auto-fill repository:', error)
        // Silently fail - user can manually select
      }
    }

    autoFillRepo()
  }, [shareInfo, isCodeTask])

  const handleConfirmCopy = async () => {
    if (!shareInfo) return

    if (isSelfShare) {
      handleSelfShare()
      return
    }

    // Validate repository and branch selection for code tasks
    if (isCodeTask) {
      if (!selectedRepo) {
        toast({
          variant: 'destructive',
          title: t('shared-task:handler_repo_required'),
        })
        return
      }
      if (!selectedBranch) {
        toast({
          variant: 'destructive',
          title: t('shared-task:handler_branch_required'),
        })
        return
      }
    }

    setIsCopying(true)
    setError(null)
    try {
      const shareToken = searchParams.get('taskShare')
      if (!shareToken) {
        throw new Error('Share token not found')
      }

      const response = await taskApis.joinSharedTask({
        share_token: shareToken,
        git_repo_id: selectedRepo?.git_repo_id,
        git_url: selectedRepo?.git_url,
        git_repo: selectedRepo?.git_repo,
        git_domain: selectedRepo?.git_domain,
        branch_name: selectedBranch?.name,
      })

      toast({
        title: t('shared-task:handler_copy_success'),
        description: `"${shareInfo.task_title}" ${t('shared-task:handler_copy_success_desc')}`,
      })

      // Refresh task list in parent component
      if (onTaskCopied) {
        onTaskCopied()
      }

      handleCloseModal()

      // Navigate to the appropriate page based on task type
      if (isCodeTask) {
        const params = new URLSearchParams()
        params.set('taskId', String(response.task_id))
        router.push(buildChatCodeHref(params))
      } else {
        router.push(`/chat?taskId=${response.task_id}`)
      }
    } catch (err) {
      console.error('Failed to copy shared task:', err)
      const errorMessage = (err as Error)?.message || 'Failed to copy task'
      toast({
        variant: 'destructive',
        title: errorMessage,
      })
      setError(errorMessage)
    } finally {
      setIsCopying(false)
    }
  }

  const handleCloseModal = () => {
    setIsModalOpen(false)
    setShareInfo(null)
    setError(null)
    cleanupUrlParams()
  }

  const handleSelfShare = () => {
    toast({
      title: t('shared-task:handler_self_task_title'),
      description: t('shared-task:handler_self_task_desc'),
    })
    handleCloseModal()
  }

  if (!shareInfo || !isModalOpen) return null

  return (
    <Modal
      isOpen={isModalOpen}
      onClose={handleCloseModal}
      title={t('shared-task:handler_modal_title')}
      maxWidth="md"
    >
      <div className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {isSelfShare ? (
          <Alert variant="warning">
            <AlertDescription>
              <span className="text-lg font-semibold text-blue-600"> {shareInfo.task_title} </span>
              {t('shared-task:handler_is_your_own_task')}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="text-center">
              <p className="text-text-primary text-base">
                <span className="text-lg font-semibold text-blue-600">{shareInfo.user_name}</span>{' '}
                {t('shared-task:handler_shared_by')}
                <span className="text-lg font-semibold text-blue-600">
                  {' '}
                  {shareInfo.task_title}
                </span>{' '}
                {t('shared-task:handler_with_you')}
              </p>
            </div>

            <Alert variant="default">
              <AlertDescription>
                {t('shared-task:handler_copy_description')}
                <span className="font-semibold"> {shareInfo.task_title} </span>
                {t('shared-task:handler_copy_description_suffix')}
              </AlertDescription>
            </Alert>

            <Alert variant="default">
              <AlertDescription>{t('shared-task:handler_original_team_notice')}</AlertDescription>
            </Alert>

            {/* Repository and Branch Selection (only for code tasks) */}
            {isCodeTask && (
              <div className="space-y-4 p-4 bg-surface/50 rounded-lg border border-border">
                <div className="flex items-center gap-2 mb-2">
                  <svg
                    className="w-5 h-5 text-primary"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                    />
                  </svg>
                  <h3 className="text-sm font-semibold text-text-primary">
                    {t('shared-task:handler_code_settings')}
                  </h3>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-text-primary flex items-center gap-1">
                      {t('common:repos.repository')}
                      <span className="text-destructive">*</span>
                    </label>
                    <RepositorySelector
                      selectedRepo={selectedRepo}
                      handleRepoChange={setSelectedRepo}
                      disabled={isCopying}
                      selectedTaskDetail={null}
                    />
                    <Alert variant="default" className="py-2">
                      <AlertDescription className="text-xs text-text-muted leading-relaxed">
                        💡 {t('shared-task:handler_repo_hint')}
                      </AlertDescription>
                    </Alert>
                  </div>

                  {selectedRepo && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-text-primary flex items-center gap-1">
                        {t('common:repos.branch')}
                        <span className="text-destructive">*</span>
                      </label>
                      <BranchSelector
                        selectedRepo={selectedRepo}
                        selectedBranch={selectedBranch}
                        handleBranchChange={setSelectedBranch}
                        disabled={isCopying}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex space-x-3 mt-6">
        <Button
          onClick={handleCloseModal}
          variant="outline"
          size="sm"
          style={{ flex: 1 }}
          disabled={isCopying}
        >
          {t('common:common.cancel')}
        </Button>
        <Button
          onClick={handleConfirmCopy}
          variant="default"
          size="sm"
          disabled={!!isSelfShare || isCopying || isRepoSelectionRequired}
          style={{ flex: 1 }}
        >
          {isCopying ? t('shared-task:handler_copying') : t('shared-task:handler_copy_to_tasks')}
        </Button>
      </div>
    </Modal>
  )
}
