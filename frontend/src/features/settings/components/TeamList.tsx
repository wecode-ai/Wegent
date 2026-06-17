// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useState, useMemo } from 'react'
import type { ReactNode } from 'react'
import '@/features/common/scrollbar.css'
import LoadingState from '@/features/common/LoadingState'
import {
  PencilIcon,
  TrashIcon,
  DocumentDuplicateIcon,
  ChatBubbleLeftEllipsisIcon,
  ShareIcon,
  CodeBracketIcon,
  CpuChipIcon,
  LinkSlashIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline'
import { Bot, Team } from '@/types/api'
import {
  fetchTeamsList,
  deleteTeam,
  shareTeam,
  checkTeamRunningTasks,
  copyTeam,
} from '../services/teams'
import { teamApis } from '@/apis/team'
import { CheckRunningTasksResponse } from '@/apis/common'
import { fetchBotsList } from '../services/bots'
import TeamEditDialog from './TeamEditDialog'
import { ForceDeleteTaskSummary } from './ForceDeleteTaskSummary'
import TeamShareModal from './TeamShareModal'
import { TeamChildNamespaceAuthorizationDialog } from './TeamChildNamespaceAuthorizationDialog'
import TeamCreationWizard from './wizard/TeamCreationWizard'
import { TeamApiCallButton } from './TeamApiCallButton'
import { useTranslation } from '@/hooks/useTranslation'
import { useGroupPermissions } from '@/hooks/useGroupPermissions'
import { useToast } from '@/hooks/use-toast'
import { getTeamDisplayName } from '@/utils/team'
import {
  isGroupTeam,
  isNamespaceAuthorizedTeam,
  isPublicTeam,
  isSharedTeam,
} from '@/utils/team-permissions'
import type { BaseRole } from '@/types/base-role'
import { sortBotsByUpdatedAt } from '@/utils/bot'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { listGroups } from '@/apis/groups'
import type { Group } from '@/types/group'
import {
  hasResourceCreateTargets,
  ResourceCreateButton,
  type ResourceCreateTarget,
} from '@/features/resource-library/components/ResourceCreateButton'
import {
  filterTeamsByMode,
  getTeamTargetPage,
  type TeamModeFilter,
  type TeamTargetPage,
} from '@/features/tasks/components/selector/team-selector-utils'
import type { ManagedResourceSourceFilter } from '@/features/resource-library/types'
import {
  buildGroupDisplayNameMap,
  sortResourceLibraryItems,
  type ResourceLibrarySortMode,
  type ResourceLibrarySortSource,
} from '@/features/resource-library/resourceSorting'
import { ResourceManagementLayout } from './resource-management/ResourceManagementLayout'

interface TeamListProps {
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
  groupRoleMap?: Map<string, BaseRole>
  onEditResource?: (namespace: string) => void
  sourceControls?: ReactNode
  sortControls?: ReactNode
  sourceFilter?: ManagedResourceSourceFilter
  groups?: Group[]
  sortMode?: ResourceLibrarySortMode
}

/**
 * Displays a list of Team (user-facing agent) resources grouped by ownership.
 * Supports CRUD operations with group-role-based permission controls.
 *
 * @param props.scope - Current scope context (personal/group/all)
 * @param props.groupName - Current group name when scope is 'group'
 * @param props.groupRoleMap - Map of group namespace to user's role
 */
export default function TeamList({
  scope = 'personal',
  groupName,
  groupRoleMap,
  onEditResource,
  sourceControls,
  sortControls,
  sourceFilter = 'all',
  groups = [],
  sortMode = 'default',
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
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [modeFilter, setModeFilter] = useState<TeamModeFilter>('all')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [createTarget, setCreateTarget] = useState<ResourceCreateTarget>({ scope: 'personal' })
  const [wizardTarget, setWizardTarget] = useState<ResourceCreateTarget>({ scope: 'personal' })
  const [copyingTeamId, setCopyingTeamId] = useState<number | null>(null)
  const [childAuthorizationTeam, setChildAuthorizationTeam] = useState<Team | null>(null)
  const [skillsDialogOpen, setSkillsDialogOpen] = useState(false)
  const [pendingCopy, setPendingCopy] = useState<{
    team: Team
    targetNamespace: string
    personalSkills: Array<{ id: number; name: string; description: string }>
  } | null>(null)
  // Groups where user has at least Developer role (for copy target selection)
  const [writableGroups, setWritableGroups] = useState<Group[]>([])
  const router = useRouter()

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
        setTeams(teamsData)
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
  }, [toast, setBotsSorted, t, scope, groupName])

  // Load groups where user has at least Developer role (for copy target selection)
  useEffect(() => {
    listGroups({ limit: 100 })
      .then(data => {
        const writable = (data.items || []).filter(
          g => g.my_role === 'Owner' || g.my_role === 'Maintainer' || g.my_role === 'Developer'
        )
        setWritableGroups(writable)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (editingTeamId === null) {
      setPrefillTeam(null)
    }
  }, [editingTeamId])

  const handleCreateTeam = (target: ResourceCreateTarget) => {
    if (target.scope === 'group' && !target.groupName) {
      toast({
        variant: 'destructive',
        title: t('teams.group_required_title'),
        description: t('teams.group_required_message'),
      })
      return
    }

    setCreateTarget(target)
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

  const executeCopyTeam = async (team: Team, targetNamespace: string, copySkills: boolean) => {
    setCopyingTeamId(team.id)
    try {
      const copied = await copyTeam(team.id, targetNamespace, copySkills)
      // Only update local list if copying to the same namespace we're currently viewing
      const currentNamespace = scope === 'group' ? groupName : 'default'
      const copiedNamespace = copied.namespace || 'default'
      if (copiedNamespace === currentNamespace) {
        setTeams(prev => [copied, ...prev])
      }
      // Refresh bots so the cloned bot (solo mode) is available in edit dialog
      fetchBotsList(scope, groupName)
        .then(setBotsSorted)
        .catch(() => {})
      toast({
        title: t('teams.copy_success'),
      })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t('teams.copy_failed'),
      })
    } finally {
      setCopyingTeamId(null)
    }
  }

  const handleSkillsDialogConfirm = async (copySkills: boolean) => {
    setSkillsDialogOpen(false)
    if (!pendingCopy) return
    await executeCopyTeam(pendingCopy.team, pendingCopy.targetNamespace, copySkills)
    setPendingCopy(null)
  }

  const handleCopyTeam = async (team: Team, targetNamespace?: string) => {
    const resolvedNamespace = targetNamespace ?? 'default'
    try {
      // Only do preflight when copying to a group namespace (not personal)
      if (resolvedNamespace !== 'default') {
        const preflight = await teamApis.copyPreflight(team.id, resolvedNamespace)
        if (preflight.personal_skills.length > 0) {
          setPendingCopy({
            team,
            targetNamespace: resolvedNamespace,
            personalSkills: preflight.personal_skills,
          })
          setSkillsDialogOpen(true)
          return
        }
      }
      // No personal skills or copying to personal — copy directly
      await executeCopyTeam(team, resolvedNamespace, false)
    } catch (error) {
      console.error('Copy preflight failed:', error)
      // Still try copying even if preflight fails
      await executeCopyTeam(team, resolvedNamespace, false)
    }
  }

  const handleCloseEditDialog = () => {
    setEditDialogOpen(false)
    setEditingTeamId(null)
    setPrefillTeam(null)
    setCreateTarget({ scope: 'personal' })
  }

  const handleWizardSuccess = async (_teamId: number, teamName: string) => {
    toast({
      title: t('wizard:create_agent'),
      description: `${teamName}`,
    })
    // Reload teams list
    const teamsData = await fetchTeamsList(scope, groupName)
    setTeams(teamsData)
    setWizardOpen(false)
  }

  const handleOpenWizard = (target: ResourceCreateTarget) => {
    if (target.scope === 'group' && !target.groupName) {
      toast({
        variant: 'destructive',
        title: t('teams.group_required_title'),
        description: t('teams.group_required_message'),
      })
      return
    }
    setWizardTarget(target)
    setWizardOpen(true)
  }

  const getActionTitle = (targetPage: TeamTargetPage) => {
    if (targetPage === 'code') {
      return t('teams.go_to_code')
    }

    if (targetPage === 'devices/chat') {
      return t('settings:team.list.goToDevice')
    }

    return t('teams.go_to_chat')
  }

  const handleChatTeam = (team: Team) => {
    const params = new URLSearchParams()
    params.set('teamId', String(team.id))
    const targetPage = getTeamTargetPage(team, modeFilter)
    router.push(`/${targetPage}?${params.toString()}`)
  }

  // Filter teams based on mode filter
  const sourceFilteredTeams = useMemo(() => {
    if (sourceFilter === 'personal') {
      return teams.filter(team => !isPublicTeam(team) && !isGroupTeam(team) && !isSharedTeam(team))
    }
    if (sourceFilter === 'group') {
      return teams.filter(isGroupTeam)
    }
    if (sourceFilter === 'system') {
      return teams.filter(isPublicTeam)
    }
    return teams
  }, [teams, sourceFilter])

  const filteredTeams = useMemo(() => {
    return filterTeamsByMode(sourceFilteredTeams, modeFilter)
  }, [sourceFilteredTeams, modeFilter])

  const groupDisplayNames = useMemo(() => buildGroupDisplayNameMap(groups), [groups])

  const getTeamSource = useCallback((team: Team): ResourceLibrarySortSource => {
    if (isPublicTeam(team)) return 'system'
    if (isGroupTeam(team) || isSharedTeam(team)) return 'group'
    return 'personal'
  }, [])

  const sortedTeams = useMemo(
    () =>
      sortResourceLibraryItems(filteredTeams, {
        sortMode,
        groupDisplayNames,
        getSource: getTeamSource,
        getName: team => team.name,
        getDisplayName: getTeamDisplayName,
        getNamespace: team => team.namespace || 'default',
        getCreatedAt: team => team.created_at,
        getUpdatedAt: team => team.updated_at,
        getStableId: team => team.id,
      }),
    [filteredTeams, sortMode, groupDisplayNames, getTeamSource]
  )

  const { canEditGroupResource, canDeleteGroupResource } = useGroupPermissions({
    scope,
    groupName,
    groupRoleMap,
  })

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
      setTeams(prev => prev.filter(team => team.id !== teamToDelete))
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
      setTeams(prev => prev.filter(team => team.id !== teamToDelete))
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
      setTeams(prev => prev.map(t => (t.id === team.id ? { ...t, share_status: 1 } : t)))
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

  // Check if edit button should be shown (uses shared permission utility)
  // Note: shouldShowEdit doesn't need userId because it checks structural properties
  // For personal teams, TeamList always shows edit (the team owner is always viewing their own teams)
  const shouldShowEdit = (team: Team) => {
    if (isPublicTeam(team)) return false
    if (isSharedTeam(team)) return false
    if (isGroupTeam(team)) {
      return canEditGroupResource(team.namespace!)
    }
    return true
  }

  // Check if delete/unbind button should be shown
  const shouldShowDelete = (team: Team) => {
    // Public teams cannot be deleted by regular users (managed by admin)
    if (isPublicTeam(team)) return false
    // For group teams, check group permissions
    if (isGroupTeam(team)) {
      return canDeleteGroupResource(team.namespace!)
    }
    // For personal teams, always show
    return true
  }

  // Check if share button should be shown
  const shouldShowShare = (team: Team) => {
    // Public teams don't support sharing (they're already globally available)
    if (isPublicTeam(team)) return false
    // Group teams don't support sharing (for now)
    if (isGroupTeam(team)) return false
    // Personal teams (no share_status or share_status=0 or share_status=1) show share button
    return !team.share_status || team.share_status === 0 || team.share_status === 1
  }

  const shouldShowChildAuthorization = (team: Team) => {
    if (isPublicTeam(team)) return false
    if (isSharedTeam(team)) return false
    if (!isGroupTeam(team)) return false
    return canEditGroupResource(team.namespace!)
  }

  // Check if copy button should be shown (same permission as create)
  const shouldShowCopy = (team: Team) => {
    // Read-only teams (public or shared from others) cannot be copied
    if (isPublicTeam(team)) return false
    if (isSharedTeam(team)) return false
    // For group teams, check group permissions (need create permission)
    if (isGroupTeam(team)) {
      return canDeleteGroupResource(team.namespace!) // Maintainer/Owner can create
    }
    // For personal teams, always show
    return true
  }

  const createGroups = groups.length > 0 ? groups : writableGroups

  const modeFilterOptions: Array<{
    value: TeamModeFilter
    label: string
    icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>
    testId: string
  }> = [
    {
      value: 'all',
      label: t('teams.filter_all'),
      testId: 'team-mode-filter-all',
    },
    {
      value: 'chat',
      label: t('teams.filter_chat'),
      icon: ChatBubbleLeftEllipsisIcon,
      testId: 'team-mode-filter-chat',
    },
    {
      value: 'code',
      label: t('teams.filter_code'),
      icon: CodeBracketIcon,
      testId: 'team-mode-filter-code',
    },
    {
      value: 'task',
      label: t('settings:team.list.filterDevice'),
      icon: CpuChipIcon,
      testId: 'team-mode-filter-device',
    },
  ]

  const createActions = hasResourceCreateTargets({
    scope,
    groupName,
    sourceFilter,
    groups: createGroups,
  }) ? (
    <>
      <ResourceCreateButton
        label={t('teams.new_team')}
        scope={scope}
        groupName={groupName}
        sourceFilter={sourceFilter}
        groups={createGroups}
        onCreate={handleCreateTeam}
        data-testid="create-team-button"
      />
      <ResourceCreateButton
        label={t('wizard:wizard_button')}
        scope={scope}
        groupName={groupName}
        sourceFilter={sourceFilter}
        groups={createGroups}
        onCreate={handleOpenWizard}
        data-testid="create-team-wizard-button"
      />
    </>
  ) : null

  const filters = (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div className="flex min-w-0 flex-col gap-3">
        {sourceControls}
        <div
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          data-testid="team-mode-filter"
        >
          <span className="text-xs font-medium text-text-muted">{t('teams.filter_mode')}</span>
          <div className="flex flex-wrap items-center gap-2">
            {modeFilterOptions.map(option => {
              const Icon = option.icon
              return (
                <Button
                  key={option.value}
                  type="button"
                  variant={modeFilter === option.value ? 'primary' : 'outline'}
                  aria-pressed={modeFilter === option.value}
                  onClick={() => setModeFilter(option.value)}
                  data-testid={option.testId}
                  className="h-11 min-w-[44px] px-4 lg:h-9"
                >
                  {Icon && <Icon className="h-4 w-4" aria-hidden />}
                  {option.label}
                </Button>
              )
            })}
          </div>
        </div>
      </div>
      {sortControls}
    </div>
  )

  return (
    <>
      <div className="flex flex-col h-full min-h-0 overflow-hidden w-full max-w-full">
        <ResourceManagementLayout
          title={t('teams.title')}
          description={t('teams.description')}
          actions={createActions}
          filters={filters}
          className="flex min-h-0 flex-1 flex-col"
        >
          {isLoading ? (
            <div className="py-12">
              <LoadingState fullScreen={false} message={t('teams.loading')} />
            </div>
          ) : (
            <div
              className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar space-y-3 pr-1"
              data-testid="team-list-items"
            >
              {sortedTeams.length > 0 ? (
                sortedTeams.map(team => (
                  <Card
                    key={team.id}
                    className="p-3 sm:p-4 bg-base hover:bg-hover transition-colors overflow-hidden"
                    data-testid={`team-card-${team.id}`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-0 min-w-0">
                      <ResourceListItem
                        name={team.name}
                        displayName={getTeamDisplayName(team)}
                        description={team.description}
                        icon={
                          <TeamIconDisplay iconId={team.icon} size="md" className="text-primary" />
                        }
                        tags={[
                          ...(isPublicTeam(team)
                            ? [
                                {
                                  key: 'public',
                                  label: t('teams.public'),
                                  variant: 'default' as const,
                                },
                              ]
                            : []),
                          ...(isGroupTeam(team)
                            ? [
                                {
                                  key: 'group',
                                  label: team.namespace!,
                                  variant: 'success' as const,
                                },
                              ]
                            : []),
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
                          ...(isNamespaceAuthorizedTeam(team) && team.namespace
                            ? [
                                {
                                  key: 'namespace-authorization',
                                  label: t('teams.authorized_from_group', {
                                    group: team.namespace,
                                  }),
                                  variant: 'success' as const,
                                },
                              ]
                            : []),
                          ...(team.share_status === 2 &&
                          team.user?.user_name &&
                          !isNamespaceAuthorizedTeam(team)
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
                          title={getActionTitle(getTeamTargetPage(team, modeFilter))}
                          className="h-7 w-7 sm:h-8 sm:w-8"
                        >
                          {getTeamTargetPage(team, modeFilter) === 'code' ? (
                            <CodeBracketIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                          ) : getTeamTargetPage(team, modeFilter) === 'devices/chat' ? (
                            <CpuChipIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                          ) : (
                            <ChatBubbleLeftEllipsisIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                          )}
                        </Button>
                        <TeamApiCallButton team={team} />
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
                        {shouldShowChildAuthorization(team) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setChildAuthorizationTeam(team)}
                            title={t('teams.child_authorization.action')}
                            className="h-7 w-7 sm:h-8 sm:w-8"
                            data-testid={`team-child-auth-button-${team.id}`}
                          >
                            <UserGroupIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                          </Button>
                        )}
                        {shouldShowCopy(team) && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                disabled={copyingTeamId === team.id}
                                title={t('teams.copy')}
                                className="h-7 w-7 sm:h-8 sm:w-8"
                                data-testid={`copy-team-button-${team.id}`}
                              >
                                {copyingTeamId === team.id ? (
                                  <Loader2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 animate-spin" />
                                ) : (
                                  <DocumentDuplicateIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                                )}
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="end"
                              className="w-44 max-h-64 overflow-y-auto py-1"
                              style={{ boxShadow: 'var(--shadow-popover)' }}
                            >
                              {/* Section label */}
                              <div className="px-2.5 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                                {t('teams.copy_to_label')}
                              </div>
                              {/* Personal space */}
                              <DropdownMenuItem
                                onClick={() => handleCopyTeam(team, 'default')}
                                className="gap-2 px-2.5 py-1.5 text-xs focus:bg-muted"
                                data-testid={`copy-team-to-personal-${team.id}`}
                              >
                                <div className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-[4px] bg-primary/10 text-primary">
                                  <svg
                                    className="h-3 w-3"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    viewBox="0 0 24 24"
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z"
                                    />
                                  </svg>
                                </div>
                                <span className="truncate">{t('teams.copy_to_personal')}</span>
                              </DropdownMenuItem>
                              {/* Groups */}
                              {writableGroups.length > 0 && (
                                <>
                                  <div className="my-1 h-px bg-border/60" />
                                  {writableGroups.map(group => {
                                    const label = group.display_name || group.name
                                    const initials = label.slice(0, 2).toUpperCase()
                                    return (
                                      <DropdownMenuItem
                                        key={group.name}
                                        onClick={() => handleCopyTeam(team, group.name)}
                                        className="gap-2 px-2.5 py-1.5 text-xs focus:bg-muted"
                                        data-testid={`copy-team-to-group-${team.id}-${group.name}`}
                                      >
                                        <div className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-[4px] bg-primary/10 text-[9px] font-semibold text-primary">
                                          {initials}
                                        </div>
                                        <span className="truncate">{label}</span>
                                      </DropdownMenuItem>
                                    )
                                  })}
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                        {shouldShowShare(team) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleShareTeam(team)}
                            title={t('teams.share.title')}
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
                <div className="text-center text-text-muted py-8" data-testid="team-empty-state">
                  <p className="text-sm">{t('teams.no_teams')}</p>
                </div>
              )}
            </div>
          )}
        </ResourceManagementLayout>
      </div>

      {/* Team Edit Dialog */}
      <TeamEditDialog
        open={editDialogOpen}
        onClose={handleCloseEditDialog}
        teams={teams}
        setTeams={setTeams}
        editingTeamId={editingTeamId}
        initialTeam={prefillTeam}
        bots={bots}
        setBots={setBotsSorted}
        toast={toast}
        scope={editingTeamId === 0 ? createTarget.scope : scope}
        groupName={
          editingTeamId === 0 && createTarget.scope === 'group' ? createTarget.groupName : groupName
        }
      />

      <TeamChildNamespaceAuthorizationDialog
        open={childAuthorizationTeam !== null}
        team={childAuthorizationTeam}
        onOpenChange={open => {
          if (!open) setChildAuthorizationTeam(null)
        }}
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
              {t('teams.force_delete_confirm_message', {
                count: runningTasksInfo?.running_tasks_count || 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <ForceDeleteTaskSummary
            runningTasks={runningTasksInfo?.running_tasks || []}
            runningTasksTitle={t('teams.running_tasks_list')}
            warning={t('teams.force_delete_warning')}
            andMoreLabel={
              runningTasksInfo && runningTasksInfo.running_tasks.length > 5
                ? `... ${t('teams.and_more_tasks', {
                    count: runningTasksInfo.running_tasks.length - 5,
                  })}`
                : undefined
            }
          />
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

      {/* Team Creation Wizard */}
      <TeamCreationWizard
        open={wizardOpen}
        onClose={() => {
          setWizardOpen(false)
          setWizardTarget({ scope: 'personal' })
        }}
        onSuccess={handleWizardSuccess}
        scope={wizardTarget.scope}
        groupName={wizardTarget.scope === 'group' ? wizardTarget.groupName : undefined}
      />

      {/* Copy Skills Confirmation Dialog */}
      <Dialog open={skillsDialogOpen} onOpenChange={setSkillsDialogOpen}>
        <DialogContent className="flex flex-col max-h-[85vh]">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>{t('teams.copy_skills_dialog_title')}</DialogTitle>
            <DialogDescription>{t('teams.copy_skills_dialog_desc')}</DialogDescription>
          </DialogHeader>
          {pendingCopy && (
            <ul className="overflow-y-auto flex-1 mt-2 space-y-1 text-sm text-text-secondary">
              {pendingCopy.personalSkills.map(s => (
                <li key={s.id} className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
                  <span className="font-medium">{s.name}</span>
                  {s.description && (
                    <span className="text-text-muted truncate">— {s.description}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <DialogFooter className="mt-4 flex-shrink-0">
            <Button variant="outline" onClick={() => handleSkillsDialogConfirm(false)}>
              {t('teams.copy_skills_skip')}
            </Button>
            <Button variant="primary" onClick={() => handleSkillsDialogConfirm(true)}>
              {t('teams.copy_skills_with')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Error prompt unified with antd message, no local rendering */}
    </>
  )
}
