// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useState, useMemo } from 'react'
import '@/features/common/scrollbar.css'
import { RiRobot2Line } from 'react-icons/ri'
import LoadingState from '@/features/common/LoadingState'
import {
  PencilIcon,
  TrashIcon,
  DocumentDuplicateIcon,
  ChatBubbleLeftEllipsisIcon,
  ShareIcon,
  CodeBracketIcon,
  LinkSlashIcon,
  SparklesIcon,
  ClipboardDocumentIcon,
} from '@heroicons/react/24/outline'
import { Bot, Team } from '@/types/api'
import { fetchTeamsList, deleteTeam, shareTeam, checkTeamRunningTasks } from '../services/teams'
import { CheckRunningTasksResponse } from '@/apis/common'
import { fetchBotsList } from '../services/bots'
import TeamEditDialog from './TeamEditDialog'
import BotList from './BotList'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'
import TeamShareModal from './TeamShareModal'
import TeamCreationWizard from './wizard/TeamCreationWizard'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import { sortTeamsByUpdatedAt } from '@/utils/team'
import { sortBotsByUpdatedAt } from '@/utils/bot'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ResourceListItem } from '@/components/common/ResourceListItem'
import { TeamIconDisplay } from './teams/TeamIconDisplay'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface TeamListProps {
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
  groupRoleMap?: Map<string, 'Owner' | 'Maintainer' | 'Developer' | 'Reporter'>
  onEditResource?: (namespace: string) => void
}

// Mode filter type
type ModeFilter = 'all' | 'chat' | 'code'

export default function TeamList({
  scope = 'personal',
  groupName,
  groupRoleMap,
  onEditResource,
}: TeamListProps) {
  const { t } = useTranslation(['common', 'wizard'])
  const { toast } = useToast()
  const [teams, setTeams] = useState<Team[]>([])
  const [bots, setBots] = useState<Bot[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [editingTeamId, setEditingTeamId] = useState<number | null>(null)
  const [prefillTeam, setPrefillTeam] = useState<Team | null>(null)
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false)
  const [forceDeleteConfirmVisible, setForceDeleteConfirmVisible] = useState(false)
  const [teamToDelete, setTeamToDelete] = useState<number | null>(null)
  const [isUnbindingSharedTeam, setIsUnbindingSharedTeam] = useState(false)
  const [runningTasksInfo, setRunningTasksInfo] = useState<CheckRunningTasksResponse | null>(null)
  const [isCheckingTasks, setIsCheckingTasks] = useState(false)
  const [shareModalVisible, setShareModalVisible] = useState(false)
  const [shareData, setShareData] = useState<{ teamName: string; shareUrl: string } | null>(null)
  const [sharingId, setSharingId] = useState<number | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [botListVisible, setBotListVisible] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all')
  const [wizardOpen, setWizardOpen] = useState(false)
  const router = useRouter()

  const setTeamsSorted = useCallback<React.Dispatch<React.SetStateAction<Team[]>>>(
    updater => {
      setTeams(prev => {
        const next =
          typeof updater === 'function' ? (updater as (value: Team[]) => Team[])(prev) : updater
        return sortTeamsByUpdatedAt(next)
      })
    },
    [setTeams]
  )

  const setBotsSorted = useCallback<React.Dispatch<React.SetStateAction<Bot[]>>>(
    updater => {
      setBots(prev => {
        const next =
          typeof updater === 'function' ? (updater as (value: Bot[]) => Bot[])(prev) : updater
        return sortBotsByUpdatedAt(next)
      })
    },
    [setBots]
  )

  useEffect(() => {
    async function loadData() {
      setIsLoading(true)
      try {
        const [teamsData, botsData] = await Promise.all([
          fetchTeamsList(scope, groupName),
          fetchBotsList(scope, groupName),
        ])
        setTeamsSorted(teamsData)
        setBotsSorted(botsData)
      } catch {
        toast({
          variant: 'destructive',
          title: t('teams.loading'),
        })
      } finally {
        setIsLoading(false)
      }
    }
    loadData()
  }, [toast, setBotsSorted, setTeamsSorted, t, scope, groupName])

  useEffect(() => {
    if (editingTeamId === null) {
      setPrefillTeam(null)
    }
  }, [editingTeamId])

  const handleCreateTeam = () => {
    // Validation for group scope: must have groupName
    if (scope === 'group' && !groupName) {
      toast({
        variant: 'destructive',
        title: t('teams.group_required_title'),
        description: t('teams.group_required_message'),
      })
      return
    }

    setPrefillTeam(null)
    setEditingTeamId(0) // Use 0 to mark new creation
    setEditDialogOpen(true)
  }

  const handleEditTeam = (team: Team) => {
    // Notify parent to update group selector if editing a group resource
    if (onEditResource && team.namespace && team.namespace !== 'default') {
      onEditResource(team.namespace)
    }
    setPrefillTeam(null)
    setEditingTeamId(team.id)
    setEditDialogOpen(true)
  }

  const handleCopyTeam = (team: Team) => {
    const clone: Team = {
      ...team,
      bots: team.bots.map(bot => ({ ...bot })),
      workflow: team.workflow ? { ...team.workflow } : {},
    }
    setPrefillTeam(clone)
    setEditingTeamId(0)
    setEditDialogOpen(true)
  }

  const handleCopyTeamName = async (team: Team) => {
    const teamNameString = `${team.namespace || 'default'}#${team.name}`
    try {
      await navigator.clipboard.writeText(teamNameString)
      toast({
        title: t('teams.copy_name_success'),
        description: teamNameString,
      })
    } catch {
      toast({
        variant: 'destructive',
        title: t('teams.copy_name_failed'),
      })
    }
  }

  const handleCloseEditDialog = () => {
    setEditDialogOpen(false)
    setEditingTeamId(null)
    setPrefillTeam(null)
  }

  const handleWizardSuccess = async (teamId: number, teamName: string) => {
    toast({
      title: t('wizard:create_agent'),
      description: `${teamName}`,
    })
    // Reload teams list
    const teamsData = await fetchTeamsList(scope, groupName)
    setTeamsSorted(teamsData)
    setWizardOpen(false)
  }

  const handleOpenWizard = () => {
    // Validation for group scope: must have groupName
    if (scope === 'group' && !groupName) {
      toast({
        variant: 'destructive',
        title: t('teams.group_required_title'),
        description: t('teams.group_required_message'),
      })
      return
    }
    setWizardOpen(true)
  }

  // Get target page based on team's bind_mode and current filter
  const getTargetPage = (team: Team): 'chat' | 'code' => {
    const bindMode = team.bind_mode || ['chat', 'code']
    // If team only supports one mode, use that
    if (bindMode.length === 1) {
      return bindMode[0]
    }
    // If team supports both, use current filter (default to 'chat' if filter is 'all')
    if (modeFilter !== 'all') {
      return modeFilter
    }
    // Default to 'chat' when filter is 'all' and team supports both
    return 'chat'
  }

  const handleChatTeam = (team: Team) => {
    const params = new URLSearchParams()
    params.set('teamId', String(team.id))
    const targetPage = getTargetPage(team)
    router.push(`/${targetPage}?${params.toString()}`)
  }

  // Filter teams based on mode filter
  const filteredTeams = useMemo(() => {
    if (modeFilter === 'all') {
      return teams
    }
    return teams.filter(team => {
      const bindMode = team.bind_mode || ['chat', 'code']
      return bindMode.includes(modeFilter)
    })
  }, [teams, modeFilter])

  // Helper function to check if a team is a group resource
  const isGroupTeam = (team: Team) => {
    return team.namespace && team.namespace !== 'default'
  }

  // Helper function to check permissions for a specific group resource
  const canEditGroupResource = (namespace: string) => {
    if (!groupRoleMap) return false
    const role = groupRoleMap.get(namespace)
    return role === 'Owner' || role === 'Maintainer' || role === 'Developer'
  }

  const canDeleteGroupResource = (namespace: string) => {
    if (!groupRoleMap) return false
    const role = groupRoleMap.get(namespace)
    return role === 'Owner' || role === 'Maintainer'
  }

  // Check if user can create in the current group context
  // When scope is 'group', check the specific groupName; only Owner/Maintainer can create
  const canCreateInCurrentGroup = (() => {
    if (scope !== 'group' || !groupName || !groupRoleMap) return false
    const role = groupRoleMap.get(groupName)
    return role === 'Owner' || role === 'Maintainer'
  })()

  const handleDelete = async (teamId: number) => {
    setTeamToDelete(teamId)
    setIsCheckingTasks(true)

    // Check if this is a shared team
    const team = teams.find(t => t.id === teamId)
    const isShared = team?.share_status === 2
    setIsUnbindingSharedTeam(isShared)

    // For shared teams, skip running tasks check and show unbind confirmation directly
    if (isShared) {
      setIsCheckingTasks(false)
      setDeleteConfirmVisible(true)
      return
    }

    try {
      // Check if team has running tasks
      const result = await checkTeamRunningTasks(teamId)
      setRunningTasksInfo(result)

      if (result.has_running_tasks) {
        // Show force delete confirmation dialog
        setForceDeleteConfirmVisible(true)
      } else {
        // Show normal delete confirmation dialog
        setDeleteConfirmVisible(true)
      }
    } catch (e) {
      // If check fails, show normal delete dialog
      console.error('Failed to check running tasks:', e)
      setDeleteConfirmVisible(true)
    } finally {
      setIsCheckingTasks(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (!teamToDelete) return

    setIsDeleting(true)
    try {
      await deleteTeam(teamToDelete)
      setTeamsSorted(prev => prev.filter(team => team.id !== teamToDelete))
      setDeleteConfirmVisible(false)
      setTeamToDelete(null)
      setRunningTasksInfo(null)
    } catch {
      toast({
        variant: 'destructive',
        title: t('teams.delete'),
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const handleForceDelete = async () => {
    if (!teamToDelete) return

    setIsDeleting(true)
    try {
      await deleteTeam(teamToDelete, true)
      setTeamsSorted(prev => prev.filter(team => team.id !== teamToDelete))
      setForceDeleteConfirmVisible(false)
      setTeamToDelete(null)
      setRunningTasksInfo(null)
    } catch {
      toast({
        variant: 'destructive',
        title: t('teams.delete'),
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const handleCancelDelete = () => {
    setDeleteConfirmVisible(false)
    setForceDeleteConfirmVisible(false)
    setTeamToDelete(null)
    setRunningTasksInfo(null)
    setIsUnbindingSharedTeam(false)
  }

  const handleShareTeam = async (team: Team) => {
    setSharingId(team.id)
    try {
      const response = await shareTeam(team.id)
      setShareData({
        teamName: team.name,
        shareUrl: response.share_url,
      })
      setShareModalVisible(true)
      // Update team status to sharing
      setTeamsSorted(prev => prev.map(t => (t.id === team.id ? { ...t, share_status: 1 } : t)))
    } catch {
      toast({
        variant: 'destructive',
        title: t('teams.share_failed'),
      })
    } finally {
      setSharingId(null)
    }
  }

  const handleCloseShareModal = () => {
    setShareModalVisible(false)
    setShareData(null)
  }

  // Check if edit button should be shown
  const shouldShowEdit = (team: Team) => {
    // Shared teams don't show edit button
    if (team.share_status === 2) return false
    // For group teams, check group permissions
    if (isGroupTeam(team)) {
      return canEditGroupResource(team.namespace!)
    }
    // For personal teams, always show
    return true
  }

  // Check if delete/unbind button should be shown
  const shouldShowDelete = (team: Team) => {
    // For group teams, check group permissions
    if (isGroupTeam(team)) {
      return canDeleteGroupResource(team.namespace!)
    }
    // For personal teams, always show
    return true
  }

  // Check if this is a shared team (need to show "unbind" instead of "delete")
  const isSharedTeam = (team: Team) => {
    return team.share_status === 2
  }

  // Check if share button should be shown
  const shouldShowShare = (team: Team) => {
    // Group teams don't support sharing (for now)
    if (isGroupTeam(team)) return false
    // Personal teams (no share_status or share_status=0 or share_status=1) show share button
    return !team.share_status || team.share_status === 0 || team.share_status === 1
  }

  // Check if copy button should be shown (same permission as create)
  const shouldShowCopy = (team: Team) => {
    // For group teams, check group permissions (need create permission)
    if (isGroupTeam(team)) {
      return canDeleteGroupResource(team.namespace!) // Maintainer/Owner can create
    }
    // For personal teams, always show
    return true
  }

  return (
    <>
      <div className="flex flex-col h-full min-h-0 overflow-hidden w-full max-w-full">
        <div className="flex-shrink-0 mb-3">
          <h2 className="text-xl font-semibold text-text-primary mb-1">{t('teams.title')}</h2>
          <p className="text-sm text-text-muted mb-1">{t('teams.description')}</p>
        </div>
        <div className="bg-base border border-border rounded-md p-2 w-full max-w-full overflow-hidden max-h-[70vh] flex flex-col overflow-y-auto custom-scrollbar">
          {/* Mode filter tabs */}
          <div className="flex items-center gap-1 mb-3 pb-2 border-b border-border">
            <button
              type="button"
              onClick={() => setModeFilter('all')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                modeFilter === 'all'
                  ? 'bg-primary text-white'
                  : 'bg-muted text-text-secondary hover:text-text-primary hover:bg-hover'
              }`}
            >
              {t('teams.filter_all')}
            </button>
            <button
              type="button"
              onClick={() => setModeFilter('chat')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                modeFilter === 'chat'
                  ? 'bg-primary text-white'
                  : 'bg-muted text-text-secondary hover:text-text-primary hover:bg-hover'
              }`}
            >
              <ChatBubbleLeftEllipsisIcon className="w-4 h-4" />
              {t('teams.filter_chat')}
            </button>
            <button
              type="button"
              onClick={() => setModeFilter('code')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                modeFilter === 'code'
                  ? 'bg-primary text-white'
                  : 'bg-muted text-text-secondary hover:text-text-primary hover:bg-hover'
              }`}
            >
              <CodeBracketIcon className="w-4 h-4" />
              {t('teams.filter_code')}
            </button>
          </div>
          {isLoading ? (
            <LoadingState fullScreen={false} message={t('teams.loading')} />
          ) : (
            <>
              <div className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar space-y-3 p-1">
                {filteredTeams.length > 0 ? (
                  filteredTeams.map(team => (
                    <Card
                      key={team.id}
                      className="p-3 sm:p-4 bg-base hover:bg-hover transition-colors overflow-hidden"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-0 min-w-0">
                        <ResourceListItem
                          name={team.name}
                          description={team.description}
                          icon={
                            <TeamIconDisplay
                              iconId={team.icon}
                              size="md"
                              className="text-primary"
                            />
                          }
                          tags={[
                            ...(team.workflow?.mode
                              ? [
                                  {
                                    key: 'mode',
                                    label: t(`team_model.${String(team.workflow.mode)}`),
                                    variant: 'default' as const,
                                    className: 'capitalize text-xs',
                                  },
                                ]
                              : []),
                            ...(team.share_status === 1
                              ? [
                                  {
                                    key: 'sharing',
                                    label: t('teams.sharing'),
                                    variant: 'info' as const,
                                  },
                                ]
                              : []),
                            ...(team.share_status === 2 && team.user?.user_name
                              ? [
                                  {
                                    key: 'shared',
                                    label: t('teams.shared_by', {
                                      author: team.user.user_name,
                                    }),
                                    variant: 'success' as const,
                                  },
                                ]
                              : []),
                            ...(team.bots.length > 0
                              ? [
                                  {
                                    key: 'bots',
                                    label: `${team.bots.length} ${team.bots.length === 1 ? 'Bot' : 'Bots'}`,
                                    variant: 'info' as const,
                                    className: 'hidden sm:inline-flex text-xs',
                                  },
                                ]
                              : []),
                          ]}
                        >
                          <div className="flex items-center space-x-1 flex-shrink-0">
                            <div
                              className="w-2 h-2 rounded-full"
                              style={{
                                backgroundColor: team.is_active
                                  ? 'rgb(var(--color-success))'
                                  : 'rgb(var(--color-border))',
                              }}
                            ></div>
                            <span className="text-xs text-text-muted">
                              {team.is_active ? t('teams.active') : t('teams.inactive')}
                            </span>
                          </div>
                        </ResourceListItem>
                        <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0 sm:ml-3 self-end sm:self-auto">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleChatTeam(team)}
                            title={
                              getTargetPage(team) === 'code'
                                ? t('teams.go_to_code')
                                : t('teams.go_to_chat')
                            }
                            className="h-7 w-7 sm:h-8 sm:w-8"
                          >
                            {getTargetPage(team) === 'code' ? (
                              <CodeBracketIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                            ) : (
                              <ChatBubbleLeftEllipsisIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                            )}
                          </Button>
                          {shouldShowEdit(team) && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleEditTeam(team)}
                              title={t('teams.edit')}
                              className="h-7 w-7 sm:h-8 sm:w-8"
                            >
                              <PencilIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                            </Button>
                          )}
                          {shouldShowCopy(team) && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleCopyTeam(team)}
                              title={t('teams.copy')}
                              className="h-7 w-7 sm:h-8 sm:w-8"
                            >
                              <DocumentDuplicateIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleCopyTeamName(team)}
                            title={t('teams.copy_name')}
                            className="h-7 w-7 sm:h-8 sm:w-8"
                          >
                            <ClipboardDocumentIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                          </Button>
                          {shouldShowShare(team) && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleShareTeam(team)}
                              title={t('teams.share')}
                              className="h-7 w-7 sm:h-8 sm:w-8"
                              disabled={sharingId === team.id}
                            >
                              <ShareIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                            </Button>
                          )}
                          {shouldShowDelete(team) && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDelete(team.id)}
                              disabled={isCheckingTasks}
                              title={isSharedTeam(team) ? t('teams.unbind') : t('teams.delete')}
                              className="h-7 w-7 sm:h-8 sm:w-8 hover:text-error"
                            >
                              {isSharedTeam(team) ? (
                                <LinkSlashIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                              ) : (
                                <TrashIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                              )}
                            </Button>
                          )}
                        </div>
                      </div>
                    </Card>
                  ))
                ) : (
                  <div className="text-center text-text-muted py-8">
                    <p className="text-sm">{t('teams.no_teams')}</p>
                  </div>
                )}
              </div>
              <div className="border-t border-border pt-3 mt-3 bg-base">
                <div className="flex justify-center gap-3">
                  {(scope === 'personal' || canCreateInCurrentGroup) && (
                    <UnifiedAddButton onClick={handleCreateTeam}>
                      {t('teams.new_team')}
                    </UnifiedAddButton>
                  )}
                  {(scope === 'personal' || canCreateInCurrentGroup) && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="primary" onClick={handleOpenWizard} className="gap-2">
                            <SparklesIcon className="w-4 h-4" />
                            {t('wizard:wizard_button')}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{t('wizard:wizard_button_tooltip')}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  <UnifiedAddButton
                    variant="outline"
                    onClick={() => setBotListVisible(true)}
                    icon={<RiRobot2Line className="w-4 h-4" />}
                  >
                    {t('bots.manage_bots')}
                  </UnifiedAddButton>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Team Edit Dialog */}
      <TeamEditDialog
        open={editDialogOpen}
        onClose={handleCloseEditDialog}
        teams={teams}
        setTeams={setTeamsSorted}
        editingTeamId={editingTeamId}
        initialTeam={prefillTeam}
        bots={bots}
        setBots={setBotsSorted}
        toast={toast}
        scope={scope}
        groupName={groupName}
      />

      {/* Delete/Unbind confirmation dialog */}
      <Dialog
        open={deleteConfirmVisible}
        onOpenChange={open => !open && !isDeleting && setDeleteConfirmVisible(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isUnbindingSharedTeam
                ? t('teams.unbind_confirm_title')
                : t('teams.delete_confirm_title')}
            </DialogTitle>
            <DialogDescription>
              {isUnbindingSharedTeam
                ? t('teams.unbind_confirm_message')
                : t('teams.delete_confirm_message')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={handleCancelDelete} disabled={isDeleting}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete} disabled={isDeleting}>
              {isDeleting ? (
                <div className="flex items-center">
                  <svg
                    className="animate-spin -ml-1 mr-2 h-4 w-4"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  {t('actions.deleting')}
                </div>
              ) : (
                t('common.confirm')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Force delete confirmation dialog for running tasks */}
      <Dialog
        open={forceDeleteConfirmVisible}
        onOpenChange={open => !open && !isDeleting && setForceDeleteConfirmVisible(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('teams.force_delete_confirm_title')}</DialogTitle>
            <DialogDescription>
              <div className="space-y-3">
                <p>
                  {t('teams.force_delete_confirm_message', {
                    count: runningTasksInfo?.running_tasks_count || 0,
                  })}
                </p>
                {runningTasksInfo && runningTasksInfo.running_tasks.length > 0 && (
                  <div className="bg-muted p-3 rounded-md">
                    <p className="font-medium text-sm mb-2">{t('teams.running_tasks_list')}</p>
                    <ul className="text-sm space-y-1">
                      {runningTasksInfo.running_tasks.slice(0, 5).map(task => (
                        <li key={task.task_id} className="text-text-muted">
                          • {task.task_title || task.task_name} ({task.status})
                        </li>
                      ))}
                      {runningTasksInfo.running_tasks.length > 5 && (
                        <li className="text-text-muted">
                          ...{' '}
                          {t('teams.and_more_tasks', {
                            count: runningTasksInfo.running_tasks.length - 5,
                          })}
                        </li>
                      )}
                    </ul>
                  </div>
                )}
                <p className="text-error text-sm">{t('teams.force_delete_warning')}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={handleCancelDelete} disabled={isDeleting}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleForceDelete} disabled={isDeleting}>
              {isDeleting ? (
                <div className="flex items-center">
                  <svg
                    className="animate-spin -ml-1 mr-2 h-4 w-4"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  {t('actions.deleting')}
                </div>
              ) : (
                t('teams.force_delete')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share success dialog */}
      {shareData && (
        <TeamShareModal
          visible={shareModalVisible}
          onClose={handleCloseShareModal}
          teamName={shareData.teamName}
          shareUrl={shareData.shareUrl}
        />
      )}

      {/* Bot list dialog */}
      <Dialog
        open={botListVisible}
        onOpenChange={open => {
          setBotListVisible(open)
          // Refresh bots list when dialog is closed to sync any changes made in BotList
          if (!open) {
            fetchBotsList(scope, groupName)
              .then(setBotsSorted)
              .catch(() => {})
          }
        }}
      >
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>{t('bots.title')}</DialogTitle>
            <DialogDescription>{t('bots.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto">
            <BotList scope={scope} groupName={groupName} groupRoleMap={groupRoleMap} />
          </div>
        </DialogContent>
      </Dialog>

      {/* Team Creation Wizard */}
      <TeamCreationWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onSuccess={handleWizardSuccess}
        scope={scope === 'all' ? undefined : scope}
        groupName={groupName}
      />
      {/* Error prompt unified with antd message, no local rendering */}
    </>
  )
}
