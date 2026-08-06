// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react'
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
import { TeamCardActionsMenu } from './TeamCardActionsMenu'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ResourceListItem } from '@/components/common/ResourceListItem'
import {
  ResourceCardIcon,
  getResourceCardActionsClassName,
  getResourceCardBodyClassName,
  getResourceCardClassName,
  getResourceGridClassName,
} from '@/components/common/resourceCardLayout'
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
  type ResourceCreateRequest,
} from '@/features/resource-library/components/ResourceCreateButton'
import {
  buildTeamTargetHref,
  filterTeamsByMode,
  getTeamTargetPage,
  type TeamModeFilter,
  type TeamTargetPage,
} from '@/features/tasks/components/selector/team-selector-utils'
import type { ManagedResourceSourceFilter } from '@/features/resource-library/types'
import {
  buildGroupDisplayNameMap,
  filterResourceLibraryItemsByGroups,
  sortResourceLibraryItems,
  type ResourceLibrarySortMode,
  type ResourceLibrarySortSource,
} from '@/features/resource-library/resourceSorting'
import { matchesResourceSearch } from '@/features/resource-library/resourceSearch'
import { ResourceManagementLayout } from './resource-management/ResourceManagementLayout'
import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { cn } from '@/lib/utils'
import { PublishedResourceIndicator } from '@/features/resource-library/components/PublishedResourceIndicator'
import { ResourceIcon } from '@/features/resource-library/components/ResourceIcon'
import { paths } from '@/config/paths'
import { useUser } from '@/features/common/UserContext'

interface TeamListProps {
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
  groupRoleMap?: Map<string, BaseRole>
  onEditResource?: (namespace: string) => void
  sourceControls?: ReactNode
  sortControls?: ReactNode
  sourceFilter?: ManagedResourceSourceFilter
  groups?: Group[]
  groupFilter?: string[]
  sortMode?: ResourceLibrarySortMode
  modeFilter?: TeamModeFilter
  onModeFilterChange?: (mode: TeamModeFilter) => void
  hideModeFilter?: boolean
  createRequest?: ResourceCreateRequest
  onCreated?: (team: Team) => void
  onCreateRequestClose?: () => void
  creationOnly?: boolean
  compact?: boolean
  hideCreateActions?: boolean
  searchQuery?: string
}

function deduplicateResourcesById<T extends { id: number }>(items: T[]): T[] {
  return Array.from(new Map(items.map(item => [item.id, item])).values())
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
  groupFilter,
  sortMode = 'default',
  modeFilter: controlledModeFilter,
  onModeFilterChange,
  hideModeFilter = false,
  createRequest,
  onCreated,
  onCreateRequestClose,
  creationOnly = false,
  compact = false,
  hideCreateActions = false,
  searchQuery = '',
}: TeamListProps) {
  const { t } = useTranslation(['common', 'wizard'])
  const { user } = useUser()
  const { toast } = useToast()
  const [teams, setTeams] = useState<Team[]>([])
  const [publishedTeamIds, setPublishedTeamIds] = useState<Set<number>>(new Set())
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
  const [internalModeFilter, setInternalModeFilter] = useState<TeamModeFilter>('all')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [createTarget, setCreateTarget] = useState<ResourceCreateTarget>({ scope: 'personal' })
  const [wizardTarget, setWizardTarget] = useState<ResourceCreateTarget>({ scope: 'personal' })
  const [copyingTeamId, setCopyingTeamId] = useState<number | null>(null)
  const [apiCallTeam, setApiCallTeam] = useState<Team | null>(null)
  const [childAuthorizationTeam, setChildAuthorizationTeam] = useState<Team | null>(null)
  const [skillsDialogOpen, setSkillsDialogOpen] = useState(false)
  const [pendingCopy, setPendingCopy] = useState<{
    team: Team
    targetNamespace: string
    personalSkills: Array<{ id: number; name: string; description: string }>
  } | null>(null)
  const modeFilter = controlledModeFilter ?? internalModeFilter
  const handledCreateRequestId = useRef<number | null>(null)
  const pendingCreateRequestRef = useRef<ResourceCreateRequest | null>(null)
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

  const loadData = useCallback(
    async (showLoading = true) => {
      if (showLoading) {
        setIsLoading(true)
      }
      try {
        const selectedGroupNames =
          scope === 'group' && !groupName && groupFilter !== undefined ? groupFilter : null
        const [teamsData, botsData] = selectedGroupNames
          ? await Promise.all([
              Promise.all(
                selectedGroupNames.map(selectedGroupName =>
                  fetchTeamsList('group', selectedGroupName)
                )
              ).then(groupTeams => deduplicateResourcesById(groupTeams.flat())),
              Promise.all(
                selectedGroupNames.map(selectedGroupName =>
                  fetchBotsList('group', selectedGroupName)
                )
              ).then(groupBots => deduplicateResourcesById(groupBots.flat())),
            ])
          : await Promise.all([fetchTeamsList(scope, groupName), fetchBotsList(scope, groupName)])
        setTeams(teamsData)
        setBotsSorted(botsData)
      } catch {
        toast({
          variant: 'destructive',
          title: t('teams.loading'),
        })
      } finally {
        if (showLoading) {
          setIsLoading(false)
        }
      }
    },
    [groupFilter, groupName, scope, setBotsSorted, t, toast]
  )

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    if (!compact) return

    let isMounted = true
    resourceLibraryApi
      .listMyPublished({ resourceType: 'agent', page: 1, limit: 100 })
      .then(response => {
        if (isMounted) {
          setPublishedTeamIds(
            new Set(response.items.filter(item => item.status === 'published').map(item => item.id))
          )
        }
      })
      .catch(() => {
        if (isMounted) setPublishedTeamIds(new Set())
      })

    return () => {
      isMounted = false
    }
  }, [compact])

  const handleTeamSaved = useCallback(
    async (team: Team) => {
      await loadData(false)
      if (pendingCreateRequestRef.current) onCreated?.(team)
      pendingCreateRequestRef.current = null
    },
    [loadData, onCreated]
  )

  const handleCreateOptionsChange = useCallback(
    (target: ResourceCreateTarget, publishAfterCreate: boolean, marketplaceTags: string[]) => {
      setCreateTarget(target)
      if (pendingCreateRequestRef.current) {
        pendingCreateRequestRef.current = {
          ...pendingCreateRequestRef.current,
          target,
          publishAfterCreate,
          marketplaceTags,
        }
      }
    },
    []
  )

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

  const handleCreateTeam = useCallback(
    (target: ResourceCreateTarget) => {
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
    },
    [t, toast]
  )

  useEffect(() => {
    if (!createRequest || handledCreateRequestId.current === createRequest.id) return
    handledCreateRequestId.current = createRequest.id
    pendingCreateRequestRef.current = createRequest
    handleCreateTeam(createRequest.target)
  }, [createRequest, handleCreateTeam])

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
    const hadPendingCreateRequest = pendingCreateRequestRef.current !== null
    pendingCreateRequestRef.current = null
    setEditDialogOpen(false)
    setEditingTeamId(null)
    setPrefillTeam(null)
    setCreateTarget({ scope: 'personal' })
    if (hadPendingCreateRequest) onCreateRequestClose?.()
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
      return t('settings:team.list.runOnDevice')
    }

    return t('teams.go_to_chat')
  }

  const handleChatTeam = (team: Team) => {
    const params = new URLSearchParams()
    params.set('teamId', String(team.id))
    const targetPage = getTeamTargetPage(team, modeFilter)
    router.push(buildTeamTargetHref(targetPage, params))
  }

  // Filter teams based on mode filter
  const sourceFilteredTeams = useMemo(() => {
    let filteredTeams = teams
    if (sourceFilter === 'personal') {
      filteredTeams = teams.filter(
        team => !isPublicTeam(team) && !isGroupTeam(team) && !isSharedTeam(team)
      )
    } else if (sourceFilter === 'group') {
      filteredTeams = teams.filter(
        team => isGroupTeam(team) || isSharedTeam(team) || isNamespaceAuthorizedTeam(team)
      )
    } else if (sourceFilter === 'system') {
      filteredTeams = teams.filter(isPublicTeam)
    } else if (sourceFilter === 'mine') {
      filteredTeams = teams.filter(team => user !== null && team.user_id === user.id)
    }

    return filteredTeams.filter(team =>
      matchesResourceSearch(
        searchQuery,
        team.name,
        getTeamDisplayName(team),
        team.description,
        team.user?.user_name
      )
    )
  }, [teams, sourceFilter, searchQuery, user])

  const groupFilteredTeams = useMemo(() => {
    const isFilteredByGroupApi = scope === 'group' && !groupName && groupFilter !== undefined
    return isFilteredByGroupApi
      ? sourceFilteredTeams
      : filterResourceLibraryItemsByGroups(sourceFilteredTeams, groupFilter, team => team.namespace)
  }, [sourceFilteredTeams, groupFilter, groupName, scope])

  const filteredTeams = useMemo(() => {
    return filterTeamsByMode(groupFilteredTeams, modeFilter)
  }, [groupFilteredTeams, modeFilter])

  const groupDisplayNames = useMemo(() => buildGroupDisplayNameMap(groups), [groups])

  const getTeamSource = useCallback((team: Team): ResourceLibrarySortSource => {
    if (isPublicTeam(team)) return 'system'
    if (isGroupTeam(team) || isSharedTeam(team) || isNamespaceAuthorizedTeam(team)) return 'group'
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
  const showAgentMarketEmptyAction =
    compact &&
    sourceFilter === 'all' &&
    teams.length === 0 &&
    searchQuery.trim().length === 0 &&
    modeFilter === 'all'

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
    // Namespace-authorized teams are managed by the publisher's binding settings.
    // Group members must not remove the authorization for the whole group.
    if (isNamespaceAuthorizedTeam(team)) return false
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
      testId: 'team-mode-filter-chat',
    },
    {
      value: 'code',
      label: t('teams.filter_code'),
      testId: 'team-mode-filter-code',
    },
    {
      value: 'task',
      label: t('settings:team.list.filterDevice'),
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
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
        {sourceControls}
        {!hideModeFilter && (
          <div
            className="flex flex-col gap-2 sm:flex-row sm:items-center"
            data-testid="team-mode-filter"
          >
            <span className="text-xs font-medium text-text-muted">{t('teams.filter_mode')}</span>
            <Select
              value={modeFilter}
              onValueChange={value => {
                const nextMode = value as TeamModeFilter
                setInternalModeFilter(nextMode)
                onModeFilterChange?.(nextMode)
              }}
            >
              <SelectTrigger
                className="h-11 w-full min-w-36 bg-base sm:w-36 lg:h-9"
                aria-label={t('teams.filter_mode')}
                data-testid="team-mode-filter-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modeFilterOptions.map(option => (
                  <SelectItem key={option.value} value={option.value} data-testid={option.testId}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2 sm:justify-end">
        {sortControls}
        {compact && !hideCreateActions && createActions}
      </div>
    </div>
  )
  const visibleFilters =
    sourceControls ||
    !hideModeFilter ||
    sortControls ||
    (compact && !hideCreateActions && createActions)
      ? filters
      : undefined

  return (
    <>
      {!creationOnly && (
        <div className="flex flex-col h-full min-h-0 overflow-hidden w-full max-w-full">
          <ResourceManagementLayout
            title={t('teams.title')}
            description={t('teams.description')}
            actions={compact || hideCreateActions ? undefined : createActions}
            filters={visibleFilters}
            hideHeader={compact}
            className="flex min-h-0 flex-1 flex-col"
          >
            {isLoading ? (
              <div className="py-12">
                <LoadingState fullScreen={false} message={t('teams.loading')} />
              </div>
            ) : (
              <div
                className={cn(
                  'min-h-0 flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar pr-1',
                  getResourceGridClassName(compact),
                  compact && 'pt-1'
                )}
                data-testid="team-list-items"
              >
                {sortedTeams.length > 0 ? (
                  sortedTeams.map(team => (
                    <Card
                      key={team.id}
                      className={cn(
                        getResourceCardClassName(compact),
                        compact && 'group relative min-h-[160px] gap-4'
                      )}
                      data-testid={`team-card-${team.id}`}
                    >
                      <div className={getResourceCardBodyClassName(compact)}>
                        <ResourceListItem
                          cardLayout={compact}
                          name={team.name}
                          displayName={getTeamDisplayName(team)}
                          description={team.description}
                          identity={
                            isGroupTeam(team) && !isNamespaceAuthorizedTeam(team)
                              ? team.namespace
                              : undefined
                          }
                          icon={
                            compact ? (
                              <ResourceIcon
                                resourceType="agent"
                                name={getTeamDisplayName(team)}
                                icon={team.icon}
                                size="sm"
                              />
                            ) : (
                              <ResourceCardIcon compact={false}>
                                <TeamIconDisplay
                                  iconId={team.icon}
                                  size="md"
                                  className="text-primary"
                                />
                              </ResourceCardIcon>
                            )
                          }
                          actions={
                            compact &&
                            (team.publication_status === 'published' ||
                              publishedTeamIds.has(team.id)) ? (
                              <PublishedResourceIndicator
                                testId={`published-agent-${team.id}-indicator`}
                              />
                            ) : undefined
                          }
                          tags={[
                            {
                              key: 'status',
                              label: team.is_active ? t('teams.active') : t('teams.inactive'),
                              variant: team.is_active ? ('success' as const) : ('default' as const),
                            },
                            ...(isPublicTeam(team)
                              ? [
                                  {
                                    key: 'public',
                                    label: t('teams.public'),
                                    variant: 'default' as const,
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
                                    label: t('teams.bot_count', { count: team.bots.length }),
                                    variant: 'info' as const,
                                    className: 'hidden sm:inline-flex text-xs',
                                  },
                                ]
                              : []),
                          ]}
                        />
                        <div
                          className={cn(
                            'flex flex-shrink-0 items-center gap-0.5 sm:gap-1',
                            getResourceCardActionsClassName(compact),
                            compact && 'flex-nowrap gap-2'
                          )}
                        >
                          {compact && shouldShowEdit(team) && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleEditTeam(team)}
                              title={t('teams.edit')}
                              className="h-11 min-w-0 flex-1 gap-2 px-3 text-xs md:h-8"
                              data-testid={`edit-team-button-${team.id}`}
                            >
                              <PencilIcon className="h-4 w-4" />
                              <span>{t('actions.edit')}</span>
                            </Button>
                          )}
                          <Button
                            variant={compact ? 'outline' : 'ghost'}
                            size={compact ? 'default' : 'icon'}
                            onClick={() => handleChatTeam(team)}
                            title={getActionTitle(getTeamTargetPage(team, modeFilter))}
                            className={cn(
                              compact
                                ? 'h-11 min-w-0 flex-1 gap-2 border-primary/[0.15] bg-primary/[0.08] px-3 text-xs text-primary hover:border-primary/20 hover:bg-primary/[0.15] md:h-8'
                                : 'h-7 w-7 sm:h-8 sm:w-8'
                            )}
                            data-testid={`use-team-button-${team.id}`}
                          >
                            {getTeamTargetPage(team, modeFilter) === 'code' ? (
                              <CodeBracketIcon className="h-4 w-4" />
                            ) : getTeamTargetPage(team, modeFilter) === 'devices/chat' ? (
                              <CpuChipIcon className="h-4 w-4" />
                            ) : compact ? (
                              <ChatBubbleLeftEllipsisIcon className="h-4 w-4" />
                            ) : (
                              <ChatBubbleLeftEllipsisIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                            )}
                            {compact && (
                              <span>{getActionTitle(getTeamTargetPage(team, modeFilter))}</span>
                            )}
                          </Button>
                          {compact ? (
                            <div
                              className="shrink-0"
                              data-testid={`team-management-actions-${team.id}`}
                            >
                              <TeamCardActionsMenu
                                team={team}
                                writableGroups={writableGroups}
                                copying={copyingTeamId === team.id}
                                checkingTasks={isCheckingTasks}
                                canEdit={false}
                                canAuthorizeChildren={shouldShowChildAuthorization(team)}
                                canCopy={shouldShowCopy(team)}
                                canShare={shouldShowShare(team)}
                                canDelete={shouldShowDelete(team)}
                                shared={isSharedTeam(team)}
                                onOpenApi={() => setApiCallTeam(team)}
                                onEdit={() => handleEditTeam(team)}
                                onAuthorizeChildren={() => setChildAuthorizationTeam(team)}
                                onCopy={targetNamespace => handleCopyTeam(team, targetNamespace)}
                                onShare={() => handleShareTeam(team)}
                                onDelete={() => handleDelete(team.id)}
                              />
                            </div>
                          ) : (
                            <div className="contents">
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
                                  className="h-11 min-w-[44px] md:h-8 md:min-w-8"
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
                                    <div className="px-2.5 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                                      {t('teams.copy_to_label')}
                                    </div>
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
                                      <span className="truncate">
                                        {t('teams.copy_to_personal')}
                                      </span>
                                    </DropdownMenuItem>
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
                          )}
                        </div>
                      </div>
                    </Card>
                  ))
                ) : (
                  <div
                    className="flex flex-col items-center gap-3 py-8 text-center text-text-muted"
                    data-testid="team-empty-state"
                  >
                    <p className="text-sm">{t('teams.no_teams')}</p>
                    {showAgentMarketEmptyAction && (
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11 min-w-[44px] rounded-xl px-4"
                        onClick={() => router.push(`${paths.resourceLibrary.getHref()}?type=agent`)}
                        data-testid="team-empty-browse-market-button"
                      >
                        {t('resource-library:actions.browse_agent_market')}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </ResourceManagementLayout>
        </div>
      )}

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
        onSaved={handleTeamSaved}
        createTarget={createTarget}
        writableGroups={writableGroups}
        publishAfterCreate={Boolean(pendingCreateRequestRef.current?.publishAfterCreate)}
        onCreateOptionsChange={handleCreateOptionsChange}
      />

      <TeamChildNamespaceAuthorizationDialog
        open={childAuthorizationTeam !== null}
        team={childAuthorizationTeam}
        onOpenChange={open => {
          if (!open) setChildAuthorizationTeam(null)
        }}
      />

      {apiCallTeam && (
        <TeamApiCallButton
          team={apiCallTeam}
          hideTrigger
          open
          onOpenChange={open => {
            if (!open) setApiCallTeam(null)
          }}
        />
      )}

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
