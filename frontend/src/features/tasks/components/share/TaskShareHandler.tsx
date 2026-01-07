// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useMemo } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { taskApis, TaskShareInfo } from '@/apis/tasks'
import { teamApis } from '@/apis/team'
import { githubApis } from '@/apis/github'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import Modal from '@/features/common/Modal'
import ModelSelector, {
  Model,
  DEFAULT_MODEL_NAME,
  allBotsHavePredefinedModel,
} from '../selector/ModelSelector'
import RepositorySelector from '../selector/RepositorySelector'
import BranchSelector from '../selector/BranchSelector'
import { Check } from 'lucide-react'
import { UsersIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Team, GitRepoInfo, GitBranch } from '@/types/api'

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
  const [teams, setTeams] = useState<Team[]>([])
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null)
  const [selectedModel, setSelectedModel] = useState<Model | null>(null)
  const [forceOverride, setForceOverride] = useState(false)
  const [isTeamSelectorOpen, setIsTeamSelectorOpen] = useState(false)
  const [teamSearchValue, setTeamSearchValue] = useState('')
  // Repository and branch selection for code tasks
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<GitBranch | null>(null)

  const isSelfShare = shareInfo && user && shareInfo.user_id === user.id
  const isCodeTask = shareInfo?.task_type === 'code'

  // Find the selected team with full details
  const selectedTeam = useMemo(() => {
    return teams.find(team => team.id === selectedTeamId) || null
  }, [teams, selectedTeamId])

  // Check if model selection is required
  const isModelSelectionRequired = useMemo(() => {
    // Skip check if team is not selected, or if team type is 'dify' (external API)
    if (!selectedTeam || selectedTeam.agent_type === 'dify') return false
    // If team's bots have predefined models, "Default" option is available, no need to force selection
    const hasDefaultOption = allBotsHavePredefinedModel(selectedTeam)
    if (hasDefaultOption) return false
    // Model selection is required when no model is selected
    return !selectedModel
  }, [selectedTeam, selectedModel])

  // Check if repository and branch are required for code tasks
  const isRepoSelectionRequired = useMemo(() => {
    return isCodeTask && (!selectedRepo || !selectedBranch)
  }, [isCodeTask, selectedRepo, selectedBranch])

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

    const fetchShareInfoAndTeams = async () => {
      setIsLoading(true)
      try {
        // Fetch share info and teams in parallel
        const [info, teamsResponse] = await Promise.all([
          taskApis.getTaskShareInfo(taskShareToken),
          teamApis.getTeams({ page: 1, limit: 100 }),
        ])

        setShareInfo(info)
        setTeams(teamsResponse.items)

        // Auto-select first team
        if (teamsResponse.items.length > 0) {
          setSelectedTeamId(teamsResponse.items[0].id)
        }

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

    fetchShareInfoAndTeams()
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

    if (!selectedTeamId) {
      toast({
        variant: 'destructive',
        title: t('shared-task:handler_select_team'),
      })
      return
    }

    // Validate model selection if required
    if (isModelSelectionRequired) {
      toast({
        variant: 'destructive',
        title: t('common:task_submit.model_required'),
      })
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

      // Determine model_id based on selection
      let modelId: string | undefined = undefined
      if (selectedModel && selectedModel.name !== DEFAULT_MODEL_NAME) {
        modelId = selectedModel.name
      }

      const response = await taskApis.joinSharedTask({
        share_token: shareToken,
        team_id: selectedTeamId,
        model_id: modelId,
        force_override_bot_model: forceOverride,
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
      const targetPage = isCodeTask ? '/code' : '/chat'
      router.push(`${targetPage}?taskId=${response.task_id}`)
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

            {/* Team Selection */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-text-primary">
                {t('shared-task:handler_select_team_label')}
              </label>
              <Popover open={isTeamSelectorOpen} onOpenChange={setIsTeamSelectorOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    role="combobox"
                    aria-expanded={isTeamSelectorOpen}
                    disabled={isCopying || teams.length === 0}
                    className={cn(
                      'flex h-10 w-full items-center justify-between rounded-md',
                      'border border-border bg-background px-3 py-2 text-sm',
                      'text-text-primary',
                      'hover:bg-hover transition-colors',
                      'focus:outline-none focus:ring-2 focus:ring-primary',
                      'disabled:cursor-not-allowed disabled:opacity-50'
                    )}
                  >
                    <span className="truncate">
                      {selectedTeam
                        ? selectedTeam.name
                        : t('shared-task:handler_select_team_label')}
                    </span>
                    <svg
                      className="ml-2 h-4 w-4 shrink-0 opacity-50"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                </PopoverTrigger>

                <PopoverContent
                  className={cn(
                    'p-0 w-[var(--radix-popover-trigger-width)] border border-border bg-background',
                    'shadow-lg rounded-md overflow-hidden'
                  )}
                  align="start"
                  sideOffset={4}
                >
                  <Command className="border-0">
                    <CommandInput
                      placeholder={t('common:teams.search_placeholder')}
                      value={teamSearchValue}
                      onValueChange={setTeamSearchValue}
                      className="h-10 border-b border-border"
                    />
                    <CommandList className="max-h-[200px] overflow-y-auto">
                      {teams.length === 0 ? (
                        <div className="py-6 text-center text-sm text-text-muted">
                          {t('shared-task:handler_no_teams')}
                        </div>
                      ) : (
                        <>
                          <CommandEmpty className="py-6 text-center text-sm text-text-muted">
                            {t('common:branches.no_match')}
                          </CommandEmpty>
                          <CommandGroup>
                            {teams.map(team => (
                              <CommandItem
                                key={team.id}
                                value={`${team.id} ${team.name}`}
                                onSelect={() => {
                                  setSelectedTeamId(team.id)
                                  setIsTeamSelectorOpen(false)
                                }}
                                className={cn(
                                  'flex items-center gap-2 px-3 py-2 text-sm cursor-pointer',
                                  'hover:bg-hover',
                                  selectedTeamId === team.id && 'bg-primary/5'
                                )}
                              >
                                <Check
                                  className={cn(
                                    'h-4 w-4 shrink-0',
                                    selectedTeamId === team.id
                                      ? 'opacity-100 text-primary'
                                      : 'opacity-0'
                                  )}
                                />
                                <UsersIcon className="w-4 h-4 flex-shrink-0 text-text-muted" />
                                <span className="truncate">{team.name}</span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {teams.length === 0 && (
                <p className="text-sm text-destructive">
                  {t('shared-task:handler_create_team_hint')}
                </p>
              )}
            </div>

            {/* Model Selection */}
            {selectedTeam && selectedTeam.agent_type !== 'dify' && (
              <ModelSelector
                selectedTeam={selectedTeam}
                selectedModel={selectedModel}
                setSelectedModel={setSelectedModel}
                forceOverride={forceOverride}
                setForceOverride={setForceOverride}
                disabled={isCopying}
              />
            )}

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
          disabled={
            !!isSelfShare ||
            isCopying ||
            teams.length === 0 ||
            isModelSelectionRequired ||
            isRepoSelectionRequired
          }
          style={{ flex: 1 }}
        >
          {isCopying ? t('shared-task:handler_copying') : t('shared-task:handler_copy_to_tasks')}
        </Button>
      </div>
    </Modal>
  )
}
