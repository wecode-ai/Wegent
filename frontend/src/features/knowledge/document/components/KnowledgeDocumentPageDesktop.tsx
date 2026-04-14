// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Desktop implementation of Knowledge Document Page.
 *
 * Hybrid navigation mode with:
 * - Left sidebar: Search, Favorites, Recent, Groups
 * - Right content area: KB detail or Group list
 */

'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { FolderOpen } from 'lucide-react'
import { userApis } from '@/apis/user'
import { teamService } from '@/features/tasks/service/teamService'
import { saveGlobalModelPreference, type ModelPreference } from '@/utils/modelPreferences'
import { getModelFromConfig } from '@/features/settings/services/bots'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import { listKnowledgeBases } from '@/apis/knowledge'
import { useKnowledgeSidebar, type KnowledgeGroup } from '../hooks/useKnowledgeSidebar'
import { useNamespaceRoleMap } from '../hooks/useNamespaceRoleMap'
import { KnowledgeSidebar } from './KnowledgeSidebar'
import { KnowledgeDetailPanel } from './KnowledgeDetailPanel'
import { KnowledgeGroupListPage, type KbDataItem } from './KnowledgeGroupListPage'
import { CreateKnowledgeBaseDialog, type AvailableGroup } from './CreateKnowledgeBaseDialog'
import { EditKnowledgeBaseDialog } from './EditKnowledgeBaseDialog'
import { DeleteKnowledgeBaseDialog } from './DeleteKnowledgeBaseDialog'
import { MigrateKnowledgeBaseDialog, type MigrationTargetGroup } from './MigrateKnowledgeBaseDialog'
import { ShareLinkDialog } from '../../permission/components/ShareLinkDialog'
import {
  canCreateKnowledgeBaseInNamespace,
  canManageKnowledgeBase,
} from '@/utils/namespace-permissions'
import { buildKbUrl } from '@/utils/knowledgeUrl'
import { migrateKnowledgeBaseToGroup } from '@/apis/knowledge'
import type {
  KnowledgeBase,
  KnowledgeBaseCreate,
  KnowledgeBaseType,
  KnowledgeBaseUpdate,
  SummaryModelRef,
} from '@/types/knowledge'
import type { DefaultTeamsResponse, Team } from '@/types/api'

// Sidebar width constant
const SIDEBAR_WIDTH = 280

interface KnowledgeDocumentPageDesktopProps {
  /** Initial KB namespace to auto-select (from virtual URL path) */
  initialKbNamespace?: string
  /** Initial KB name to auto-select (from virtual URL path) */
  initialKbName?: string
  /** Initial document path to auto-open (from virtual URL path segments) */
  initialDocPath?: string
}

export function KnowledgeDocumentPageDesktop({
  initialKbNamespace,
  initialKbName,
  initialDocPath,
}: KnowledgeDocumentPageDesktopProps = {}) {
  const { t } = useTranslation('knowledge')
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user } = useUser()

  // Knowledge sidebar hook
  const sidebar = useKnowledgeSidebar()
  const namespaceRoleMap = useNamespaceRoleMap()

  // Sidebar collapse state - auto-collapse when notebook KB is selected
  // Use localStorage to sync state with parent components (for TopNavigation expand button)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('knowledge-sidebar-collapsed') === 'true'
    }
    return false
  })

  // Sync collapse state to localStorage and dispatch custom event for parent components
  const updateSidebarCollapsed = useCallback((collapsed: boolean) => {
    setIsSidebarCollapsed(collapsed)
    if (typeof window !== 'undefined') {
      localStorage.setItem('knowledge-sidebar-collapsed', String(collapsed))
      // Dispatch custom event so parent components can react
      window.dispatchEvent(
        new CustomEvent('knowledge-sidebar-collapse-change', { detail: { collapsed } })
      )
    }
  }, [])

  // Listen for collapse changes from parent components (e.g., TopNavigation expand button)
  useEffect(() => {
    const handleCollapseChange = (event: CustomEvent<{ collapsed: boolean }>) => {
      // Only update local state, don't dispatch event again to avoid infinite loop
      setIsSidebarCollapsed(event.detail.collapsed)
    }

    window.addEventListener(
      'knowledge-sidebar-collapse-change',
      handleCollapseChange as EventListener
    )

    return () => {
      window.removeEventListener(
        'knowledge-sidebar-collapse-change',
        handleCollapseChange as EventListener
      )
    }
  }, [])

  // Listen for clear selection event from TaskSidebar (when user clicks "知识" button while already on knowledge page)
  useEffect(() => {
    const handleClearSelection = () => {
      sidebar.clearSelection()
    }

    window.addEventListener('knowledge-clear-selection', handleClearSelection)

    return () => {
      window.removeEventListener('knowledge-clear-selection', handleClearSelection)
    }
  }, [sidebar.clearSelection])

  // Group KBs for the selected group
  const [groupKbs, setGroupKbs] = useState<KnowledgeBase[]>([])
  const [isGroupKbsLoading, setIsGroupKbsLoading] = useState(false)

  // Dialog states
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [createScope, setCreateScope] = useState<'personal' | 'group' | 'organization'>('personal')
  const [createGroupName, setCreateGroupName] = useState<string | undefined>(undefined)
  const [createKbType, setCreateKbType] = useState<KnowledgeBaseType>('notebook')
  const [showGroupSelector, setShowGroupSelector] = useState(false)
  const [editingKb, setEditingKb] = useState<KnowledgeBase | null>(null)
  const [deletingKb, setDeletingKb] = useState<KnowledgeBase | null>(null)
  const [sharingKb, setSharingKb] = useState<KnowledgeBase | null>(null)
  const [migratingKb, setMigratingKb] = useState<KnowledgeBase | null>(null)

  // Loading states for dialogs
  const [isCreating, setIsCreating] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isMigrating, setIsMigrating] = useState(false)

  // Default teams config for saving model preference
  const [defaultTeamsConfig, setDefaultTeamsConfig] = useState<DefaultTeamsResponse | null>(null)
  const [teams, setTeams] = useState<Team[]>([])

  // Load default teams config and teams list on mount
  useEffect(() => {
    const loadDefaultTeamsAndTeams = async () => {
      try {
        const [defaultTeamsRes, teamsRes] = await Promise.all([
          userApis.getDefaultTeams(),
          teamService.getTeams(),
        ])
        setDefaultTeamsConfig(defaultTeamsRes)
        setTeams(teamsRes.items || [])
      } catch (error) {
        console.error('Failed to load default teams config:', error)
      }
    }
    loadDefaultTeamsAndTeams()
  }, [])

  // Find knowledge mode default team and its bind_model
  const knowledgeTeamInfo = useMemo(() => {
    if (!defaultTeamsConfig?.knowledge || teams.length === 0) {
      return { id: null, bindModel: null as string | null }
    }

    const { name, namespace } = defaultTeamsConfig.knowledge
    const normalizedNamespace = namespace || 'default'

    const matchedTeam = teams.find(team => {
      const teamNamespace = team.namespace || 'default'
      return team.name === name && teamNamespace === normalizedNamespace
    })

    // Get bind_model from team's first bot config
    let bindModel: string | null = null
    if (matchedTeam?.bots?.length) {
      const firstBot = matchedTeam.bots[0]
      const botConfig = firstBot?.bot?.agent_config as Record<string, unknown> | undefined
      if (botConfig) {
        bindModel = getModelFromConfig(botConfig)
      }
    }

    return {
      id: matchedTeam?.id ?? null,
      bindModel,
    }
  }, [defaultTeamsConfig, teams])

  const knowledgeDefaultTeamId = knowledgeTeamInfo.id
  const knowledgeBindModel = knowledgeTeamInfo.bindModel

  // Helper: save summary model to knowledge team's preference
  const saveSummaryModelToPreference = useCallback(
    (summaryModelRef: SummaryModelRef | null | undefined) => {
      if (!knowledgeDefaultTeamId || !summaryModelRef?.name) return

      const preference: ModelPreference = {
        modelName: summaryModelRef.name,
        modelType: summaryModelRef.type,
        forceOverride: true,
        updatedAt: Date.now(),
      }

      saveGlobalModelPreference(knowledgeDefaultTeamId, preference)
    },
    [knowledgeDefaultTeamId]
  )

  // Track if initial URL sync has been done (useState so re-render is triggered when done)
  const [initialUrlSyncDone, setInitialUrlSyncDone] = useState(false)

  // Sync selected KB or group from URL parameter on initial load only
  // This effect only runs once when allKnowledgeBases is loaded
  // Supports two modes:
  //   1. Virtual URL mode: initialKbNamespace + initialKbName props (from /knowledge/[ns]/[name] route)
  //   2. Query param mode: ?kb=<id> or ?group=<id> (from /knowledge page)
  useEffect(() => {
    // Skip if already synced
    if (initialUrlSyncDone) return

    // Wait for data to finish loading before attempting to sync
    if (sidebar.isGroupsLoading) return

    // Mode 1: Virtual URL - select KB by namespace + name
    if (initialKbName) {
      let found: (typeof sidebar.allKnowledgeBases)[0] | undefined

      if (initialKbNamespace) {
        // Personal or team KB: match by both namespace and name
        found = sidebar.allKnowledgeBases.find(
          kb =>
            kb.name.toLowerCase() === initialKbName.toLowerCase() &&
            kb.namespace.toLowerCase() === initialKbNamespace.toLowerCase()
        )
      } else {
        // Organization KB (URL uses "public"): match by name only
        found = sidebar.allKnowledgeBases.find(
          kb => kb.name.toLowerCase() === initialKbName.toLowerCase()
        )
      }

      if (found) {
        sidebar.selectKb(found)
      }
      // Mark sync as done regardless of whether KB was found
      // (if not found, renderMainContent will show the not-found state)
      setInitialUrlSyncDone(true)
      return
    }

    // Mode 2: Query params - select KB by id or group
    const kbParam = searchParams.get('kb')
    const groupParam = searchParams.get('group')

    if (kbParam) {
      const kbId = parseInt(kbParam, 10)
      if (!isNaN(kbId)) {
        const found = sidebar.allKnowledgeBases.find(kb => kb.id === kbId)
        if (found) {
          sidebar.selectKb(found)
        }
      }
    } else if (groupParam) {
      // Restore group selection from URL
      sidebar.selectGroup(groupParam)
    }
    // Mark as synced (whether or not we found anything)
    setInitialUrlSyncDone(true)
  }, [
    searchParams,
    sidebar.allKnowledgeBases,
    sidebar.isGroupsLoading,
    sidebar.selectKb,
    sidebar.selectGroup,
    initialKbNamespace,
    initialKbName,
    initialUrlSyncDone,
  ])

  // Helper function to update URL parameters for group/all navigation
  const updateUrlParams = useCallback(
    (params: { kb?: number | null; group?: string | null }) => {
      // KB selection is handled by navigateToKb - skip here
      if (params.kb !== undefined && params.kb !== null) return

      // In virtual URL mode, navigating to group/all means going back to /knowledge
      if (initialKbNamespace !== undefined) {
        const newSearchParams = new URLSearchParams()
        newSearchParams.set('type', 'document')
        if (params.group !== undefined && params.group !== null) {
          newSearchParams.set('group', params.group)
        }
        router.push(`/knowledge?${newSearchParams.toString()}`)
        return
      }

      const newSearchParams = new URLSearchParams(searchParams.toString())

      // Always preserve type=document
      newSearchParams.set('type', 'document')

      // Remove kb param when navigating away from a KB
      newSearchParams.delete('kb')

      if (params.group !== undefined) {
        if (params.group === null) {
          newSearchParams.delete('group')
        } else {
          newSearchParams.set('group', params.group)
        }
      }

      router.replace(`?${newSearchParams.toString()}`, { scroll: false })
    },
    [router, searchParams, initialKbNamespace]
  )

  // Navigate to KB detail page using canonical URL path
  const navigateToKb = useCallback(
    (kb: { name: string; namespace: string }) => {
      // Determine isOrganization from allKnowledgeBasesWithGroupInfo group_type
      const kbWithInfo = sidebar.allKnowledgeBasesWithGroupInfo.find(
        k => k.name === kb.name && k.namespace === kb.namespace
      )
      const isOrganization = kbWithInfo?.group_type === 'organization'
      const kbPath = buildKbUrl(kb.namespace, kb.name, isOrganization)
      router.push(kbPath)
    },
    [router, sidebar.allKnowledgeBasesWithGroupInfo]
  )

  // Helper function to convert KnowledgeBaseWithGroupInfo to KnowledgeBase
  const toKnowledgeBase = useCallback(
    (kb: {
      id: number
      name: string
      description: string | null
      user_id: number
      namespace: string
      document_count: number
      kb_type?: string
      created_at: string
      updated_at: string
    }): KnowledgeBase => ({
      id: kb.id,
      name: kb.name,
      description: kb.description,
      user_id: kb.user_id,
      namespace: kb.namespace,
      document_count: kb.document_count,
      is_active: true,
      summary_enabled: false,
      kb_type: (kb.kb_type as KnowledgeBaseType) || 'notebook',
      max_calls_per_conversation: 10,
      exempt_calls_before_check: 5,
      created_at: kb.created_at,
      updated_at: kb.updated_at,
    }),
    []
  )

  // Load group KBs when a group is selected
  useEffect(() => {
    if (!sidebar.selectedGroupId) {
      setGroupKbs([])
      return
    }

    // Track current request to handle race conditions
    let isCancelled = false

    const loadGroupKbs = async () => {
      setIsGroupKbsLoading(true)
      try {
        const selectedGroup = sidebar.groups.find(g => g.id === sidebar.selectedGroupId)
        if (!selectedGroup) return

        let kbs: KnowledgeBase[] = []
        if (selectedGroup.type === 'personal') {
          // Use the pre-grouped personal KBs from the sidebar hook
          // This includes both created_by_me and shared_with_me KBs
          const personalKbs = [...sidebar.personalCreatedByMe, ...sidebar.personalSharedWithMe]
          kbs = personalKbs.map(toKnowledgeBase)
        } else if (selectedGroup.type === 'organization') {
          const res = await listKnowledgeBases('organization')
          kbs = res.items || []
        } else if (selectedGroup.type === 'group' && selectedGroup.name) {
          const res = await listKnowledgeBases('group', selectedGroup.name)
          kbs = res.items || []
        }

        // Only update state if this request wasn't cancelled
        if (!isCancelled) {
          setGroupKbs(kbs)
        }
      } catch (error) {
        if (!isCancelled) {
          console.error('Failed to load group KBs:', error)
          setGroupKbs([])
        }
      } finally {
        if (!isCancelled) {
          setIsGroupKbsLoading(false)
        }
      }
    }

    loadGroupKbs()

    // Cleanup function to cancel stale requests
    return () => {
      isCancelled = true
    }
  }, [
    sidebar.selectedGroupId,
    sidebar.groups,
    sidebar.personalCreatedByMe,
    sidebar.personalSharedWithMe,
    toKnowledgeBase,
  ])
  // Auto-collapse sidebar when a notebook KB is selected
  useEffect(() => {
    if (sidebar.selectedKb) {
      // Collapse sidebar when notebook KB is selected
      if (sidebar.selectedKb.kb_type === 'notebook') {
        updateSidebarCollapsed(true)
      } else {
        // Expand sidebar for classic KB
        updateSidebarCollapsed(false)
      }
    } else {
      // Expand sidebar when no KB is selected (showing list view)
      updateSidebarCollapsed(false)
    }
  }, [sidebar.selectedKb, updateSidebarCollapsed])

  // Get selected group info
  const selectedGroup = useMemo((): KnowledgeGroup | null => {
    if (!sidebar.selectedGroupId) return null
    return sidebar.groups.find(g => g.id === sidebar.selectedGroupId) || null
  }, [sidebar.selectedGroupId, sidebar.groups])

  const canCreateInSelectedGroup = useMemo(() => {
    if (!selectedGroup) {
      return false
    }

    if (selectedGroup.type === 'personal') {
      return true
    }

    return canCreateKnowledgeBaseInNamespace({
      namespace: selectedGroup.name,
      namespaceRole: namespaceRoleMap.get(selectedGroup.name),
    })
  }, [selectedGroup, namespaceRoleMap])

  const canManageKbInList = useCallback(
    (kb: KbDataItem) => {
      return canManageKnowledgeBase({
        currentUserId: user?.id,
        knowledgeBase: kb,
        knowledgeRole: 'my_role' in kb ? (kb.my_role ?? undefined) : undefined,
        namespaceRole: namespaceRoleMap.get(kb.namespace),
      })
    },
    [user?.id, namespaceRoleMap]
  )

  // Handle KB selection (supports both KnowledgeBase and KnowledgeBaseWithGroupInfo)
  const handleSelectKb = useCallback(
    (kb: KnowledgeBase | { id: number; name: string; namespace: string }) => {
      // Find the full KB from allKnowledgeBases to ensure we have all fields
      const fullKb = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
      if (fullKb) {
        sidebar.selectKb(fullKb)
        // Navigate to canonical KB URL path: /knowledge/{namespace}/{kbName}
        navigateToKb(fullKb)
      }
    },
    [sidebar, navigateToKb]
  )

  // Handle "All" selection
  const handleSelectAll = useCallback(() => {
    sidebar.selectAll()
    // Clear kb and group params from URL
    updateUrlParams({ kb: null, group: null })
  }, [sidebar, updateUrlParams])

  // Handle group selection
  const handleSelectGroup = useCallback(
    (groupId: string) => {
      sidebar.selectGroup(groupId)
      // Update URL with group parameter
      updateUrlParams({ group: groupId, kb: null })
    },
    [sidebar, updateUrlParams]
  )

  // Handle back from group list
  const handleBackFromGroup = useCallback(() => {
    sidebar.clearSelection()
    // Clear kb and group params from URL
    updateUrlParams({ kb: null, group: null })
  }, [sidebar, updateUrlParams])

  // Handle create KB from group list
  const handleCreateKbFromGroup = useCallback(
    (kbType: KnowledgeBaseType) => {
      if (!selectedGroup) return

      if (selectedGroup.type === 'personal') {
        setCreateScope('personal')
        setCreateGroupName(undefined)
      } else if (selectedGroup.type === 'organization') {
        setCreateScope('organization')
        setCreateGroupName(undefined)
      } else {
        setCreateScope('group')
        setCreateGroupName(selectedGroup.name)
      }
      setCreateKbType(kbType)
      setShowCreateDialog(true)
    },
    [selectedGroup]
  )

  // Handle KB created
  const handleCreate = useCallback(
    async (data: Omit<KnowledgeBaseCreate, 'namespace'> & { selectedGroupId?: string }) => {
      setIsCreating(true)
      try {
        // Determine namespace based on scope or selectedGroupId
        let namespace = 'default'

        // If selectedGroupId is provided (from group selector), use it to determine namespace
        if (data.selectedGroupId) {
          const selectedGroup = sidebar.groups.find(g => g.id === data.selectedGroupId)
          if (selectedGroup) {
            if (selectedGroup.type === 'personal') {
              namespace = 'default'
            } else if (selectedGroup.type === 'organization') {
              namespace = selectedGroup.name
            } else {
              namespace = selectedGroup.name
            }
          }
        } else if (createScope === 'organization') {
          // Get org namespace from groups
          const orgGroup = sidebar.groups.find(g => g.type === 'organization')
          namespace = orgGroup?.name || 'organization'
        } else if (createGroupName) {
          namespace = createGroupName
        }

        // Use kb_type from dialog (user can change it in the dialog)
        const kbType = data.kb_type || createKbType

        // Use the appropriate API based on scope
        const { createKnowledgeBase } = await import('@/apis/knowledge')
        await createKnowledgeBase({
          name: data.name,
          description: data.description,
          namespace,
          retrieval_config: data.retrieval_config,
          summary_enabled: data.summary_enabled,
          summary_model_ref: data.summary_model_ref,
          kb_type: kbType,
          guided_questions: data.guided_questions,
          max_calls_per_conversation: data.max_calls_per_conversation,
          exempt_calls_before_check: data.exempt_calls_before_check,
        })

        // Save model preference when summary is enabled and model is selected
        if (data.summary_enabled && data.summary_model_ref) {
          saveSummaryModelToPreference(data.summary_model_ref)
        }
        setShowCreateDialog(false)

        // Refresh sidebar data
        await sidebar.refreshAll()

        // Reload group KBs if a group is selected
        if (sidebar.selectedGroupId) {
          const selectedGroup = sidebar.groups.find(g => g.id === sidebar.selectedGroupId)
          if (selectedGroup) {
            let kbs: KnowledgeBase[] = []
            if (selectedGroup.type === 'organization') {
              const res = await listKnowledgeBases('organization')
              kbs = res.items || []
            } else if (selectedGroup.type === 'group' && selectedGroup.name) {
              const res = await listKnowledgeBases('group', selectedGroup.name)
              kbs = res.items || []
            }
            setGroupKbs(kbs)
          }
        }

        setCreateGroupName(undefined)
        setCreateScope('personal')
        setCreateKbType('notebook')
      } finally {
        setIsCreating(false)
      }
    },
    [createScope, createGroupName, createKbType, sidebar, saveSummaryModelToPreference]
  )
  // Handle KB updated
  const handleUpdate = useCallback(
    async (data: KnowledgeBaseUpdate) => {
      if (!editingKb) return

      setIsUpdating(true)
      try {
        const { updateKnowledgeBase } = await import('@/apis/knowledge')
        await updateKnowledgeBase(editingKb.id, data)

        // Save model preference when summary is enabled and model is selected
        if (data.summary_enabled && data.summary_model_ref) {
          saveSummaryModelToPreference(data.summary_model_ref)
        }

        // Refresh sidebar data
        await sidebar.refreshAll()

        setEditingKb(null)
      } finally {
        setIsUpdating(false)
      }
    },
    [editingKb, sidebar, saveSummaryModelToPreference]
  )

  // Handle KB deleted
  const handleDelete = useCallback(async () => {
    if (!deletingKb) return

    setIsDeleting(true)
    try {
      const { deleteKnowledgeBase } = await import('@/apis/knowledge')
      await deleteKnowledgeBase(deletingKb.id)

      // Refresh sidebar data
      await sidebar.refreshAll()

      // Clear selection if deleted KB was selected
      if (deletingKb.id === sidebar.selectedKbId) {
        sidebar.clearSelection()
      }

      setDeletingKb(null)
    } finally {
      setIsDeleting(false)
    }
  }, [deletingKb, sidebar])

  // Handle KB migrated
  const handleMigrate = useCallback(
    async (targetGroupName: string) => {
      if (!migratingKb) return

      setIsMigrating(true)
      try {
        await migrateKnowledgeBaseToGroup(migratingKb.id, targetGroupName)

        // Refresh sidebar data only on success
        await sidebar.refreshAll()

        // Clear selection if migrated KB was selected
        if (migratingKb.id === sidebar.selectedKbId) {
          sidebar.clearSelection()
        }

        // Only close dialog on success
        setMigratingKb(null)
      } catch (error) {
        // Re-throw the error so MigrateKnowledgeBaseDialog can handle it
        // and display the error message to the user
        throw error
      } finally {
        setIsMigrating(false)
      }
    },
    [migratingKb, sidebar]
  )

  // Check if KB can be migrated (only personal KBs created by current user)
  const canMigrateKb = useCallback(
    (kb: { id: number; namespace: string; user_id: number }) => {
      // Only personal KBs (namespace='default') can be migrated
      if (kb.namespace !== 'default') return false
      // Only the creator can migrate
      return kb.user_id === sidebar.currentUser?.id
    },
    [sidebar.currentUser]
  )

  // Build available target groups for migration (groups and organizations only)
  const availableMigrationGroups = useMemo((): MigrationTargetGroup[] => {
    return sidebar.groups
      .filter(g => g.type === 'group' || g.type === 'organization')
      .map(g => ({
        id: g.id,
        name: g.name,
        displayName: g.displayName,
        type: g.type as 'group' | 'organization',
      }))
  }, [sidebar.groups])
  // Check if KB is favorite
  const isFavorite = useCallback(
    (kbId: number) => {
      return sidebar.favorites.some(kb => kb.id === kbId)
    },
    [sidebar.favorites]
  )

  // Toggle favorite
  const handleToggleFavorite = useCallback(
    async (kbId: number, shouldFavorite: boolean) => {
      if (shouldFavorite) {
        await sidebar.addFavorite(kbId)
      } else {
        await sidebar.removeFavorite(kbId)
      }
    },
    [sidebar]
  )

  // Handle "Groups" selection - show all team groups' KBs combined
  const handleSelectGroups = useCallback(() => {
    sidebar.selectGroups()
    // Update URL with groups parameter
    updateUrlParams({ kb: null, group: 'all-groups' })
  }, [sidebar, updateUrlParams])

  // Handle create KB from "All" page
  const handleCreateKbFromAll = useCallback((kbType: KnowledgeBaseType) => {
    // Show group selector when creating from "All" page
    setCreateScope('personal')
    setCreateGroupName(undefined)
    setCreateKbType(kbType)
    setShowGroupSelector(true)
    setShowCreateDialog(true)
  }, [])

  // Handle create KB from "Groups" page
  const handleCreateKbFromGroups = useCallback((kbType: KnowledgeBaseType) => {
    // Show group selector when creating from "Groups" page (only team groups)
    setCreateScope('group')
    setCreateGroupName(undefined)
    setCreateKbType(kbType)
    setShowGroupSelector(true)
    setShowCreateDialog(true)
  }, [])

  // Build available groups for filter dropdown
  const availableGroups = useMemo(() => {
    return sidebar.groups.map(g => ({
      id: g.id,
      name: g.name,
      displayName: g.displayName,
    }))
  }, [sidebar.groups])

  // Build available groups for create dialog (with canCreate flag)
  const availableGroupsForCreate = useMemo((): AvailableGroup[] => {
    return sidebar.groups.map(g => ({
      id: g.id,
      name: g.name,
      displayName: g.displayName,
      type: g.type,
      canCreate:
        g.type === 'personal'
          ? true
          : canCreateKnowledgeBaseInNamespace({
              namespace: g.name,
              namespaceRole: namespaceRoleMap.get(g.name),
            }),
    }))
  }, [sidebar.groups, namespaceRoleMap])

  const hasCreatableTeamGroup = useMemo(() => {
    return availableGroupsForCreate.some(group => group.type === 'group' && group.canCreate)
  }, [availableGroupsForCreate])

  // Get group info for the selected KB
  const selectedKbGroupInfo = sidebar.selectedKb
    ? sidebar.getKbGroupInfo(sidebar.selectedKb)
    : undefined

  // Handle group click from KB detail panel - navigate to group list
  // Need to convert KbGroupInfo's groupId to sidebar's group ID format
  const handleGroupClick = useCallback(
    (groupId: string, groupType?: string) => {
      // Convert groupId based on groupType to match sidebar's group ID format
      let sidebarGroupId: string
      if (groupType === 'personal' || groupId === 'default') {
        sidebarGroupId = 'personal'
      } else if (groupType === 'organization') {
        sidebarGroupId = 'organization'
      } else {
        // For team groups, the sidebar uses "group-{group_name}" format
        sidebarGroupId = `group-${groupId}`
      }
      sidebar.selectGroup(sidebarGroupId)
      // Update URL with group parameter
      updateUrlParams({ group: sidebarGroupId, kb: null })
    },
    [sidebar, updateUrlParams]
  )

  const renderMainContent = () => {
    // If a KB is selected, show detail panel
    if (sidebar.selectedKb) {
      return (
        <KnowledgeDetailPanel
          selectedKb={sidebar.selectedKb}
          isTreeCollapsed={isSidebarCollapsed}
          onExpandTree={() => updateSidebarCollapsed(false)}
          onEditKb={setEditingKb}
          groupInfo={selectedKbGroupInfo}
          onGroupClick={handleGroupClick}
          initialDocPath={initialDocPath}
        />
      )
    }

    // If "Groups" mode is selected, show all team groups' KBs combined
    if (sidebar.viewMode === 'groups') {
      // Filter to only show KBs from team groups (type === 'group')
      const teamGroupKbs = sidebar.allKnowledgeBasesWithGroupInfo.filter(
        kb => kb.group_type === 'group'
      )

      return (
        <KnowledgeGroupListPage
          groupId={null}
          groupName={t('document.sidebar.groups', '分组')}
          knowledgeBases={teamGroupKbs.map(kb => ({
            id: kb.id,
            name: kb.name,
            description: kb.description,
            user_id: kb.user_id,
            namespace: kb.namespace,
            document_count: kb.document_count,
            is_active: true,
            summary_enabled: false,
            kb_type: kb.kb_type || 'notebook',
            max_calls_per_conversation: 10,
            exempt_calls_before_check: 5,
            created_at: kb.created_at,
            updated_at: kb.updated_at,
          }))}
          knowledgeBasesWithGroupInfo={teamGroupKbs}
          isLoading={sidebar.isGroupsLoading}
          onSelectKb={handleSelectKb}
          onCreateKb={hasCreatableTeamGroup ? handleCreateKbFromGroups : undefined}
          onEditKb={kb => {
            const fullKb = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
            if (fullKb) setEditingKb(fullKb)
          }}
          onDeleteKb={kb => {
            const fullKb = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
            if (fullKb) setDeletingKb(fullKb)
          }}
          canManageKb={canManageKbInList}
          onToggleFavorite={handleToggleFavorite}
          isFavorite={isFavorite}
          getKbGroupInfo={sidebar.getKbGroupInfo}
          isAllMode={true}
          filterGroupId={sidebar.filterGroupId}
          onFilterGroupChange={sidebar.setFilterGroupId}
          availableGroups={availableGroups.filter(g => g.id.startsWith('group-'))}
        />
      )
    }

    // If "All" mode is selected, show all KBs with group info
    if (sidebar.viewMode === 'all') {
      return (
        <KnowledgeGroupListPage
          groupId={null}
          groupName={t('document.allKnowledgeBases', '全部知识库')}
          knowledgeBases={sidebar.allKnowledgeBases}
          knowledgeBasesWithGroupInfo={sidebar.allKnowledgeBasesWithGroupInfo}
          isLoading={sidebar.isGroupsLoading}
          onSelectKb={handleSelectKb}
          onCreateKb={handleCreateKbFromAll}
          onEditKb={kb => {
            const fullKb = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
            if (fullKb) setEditingKb(fullKb)
          }}
          onDeleteKb={kb => {
            const fullKb = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
            if (fullKb) setDeletingKb(fullKb)
          }}
          canManageKb={canManageKbInList}
          onToggleFavorite={handleToggleFavorite}
          isFavorite={isFavorite}
          getKbGroupInfo={sidebar.getKbGroupInfo}
          isAllMode={true}
          filterGroupId={sidebar.filterGroupId}
          onFilterGroupChange={sidebar.setFilterGroupId}
          availableGroups={availableGroups}
        />
      )
    }

    // If a group is selected, show group list
    if (selectedGroup) {
      // Check if this is personal mode
      const isPersonalMode = selectedGroup.type === 'personal'

      // Filter KBs with group info for this specific group to get my_role
      const groupKbsWithInfo = sidebar.allKnowledgeBasesWithGroupInfo.filter(kb => {
        if (selectedGroup.type === 'personal') {
          return kb.group_type === 'personal'
        } else if (selectedGroup.type === 'organization') {
          return kb.group_type === 'organization'
        } else {
          // For team groups, match by namespace (group_id contains the namespace)
          // selectedGroup.name is the namespace (e.g., "test/group2/ttt")
          // kb.namespace is also the namespace
          return kb.group_type === 'group' && kb.namespace === selectedGroup.name
        }
      })

      return (
        <KnowledgeGroupListPage
          groupId={selectedGroup.id}
          groupName={selectedGroup.displayName}
          knowledgeBases={groupKbs}
          knowledgeBasesWithGroupInfo={groupKbsWithInfo}
          isLoading={isGroupKbsLoading}
          onBack={handleBackFromGroup}
          onSelectKb={handleSelectKb}
          onCreateKb={canCreateInSelectedGroup ? handleCreateKbFromGroup : undefined}
          onEditKb={kb => {
            const fullKb =
              sidebar.allKnowledgeBases.find(k => k.id === kb.id) ||
              groupKbs.find(k => k.id === kb.id)
            if (fullKb) setEditingKb(fullKb)
          }}
          onDeleteKb={kb => {
            const fullKb =
              sidebar.allKnowledgeBases.find(k => k.id === kb.id) ||
              groupKbs.find(k => k.id === kb.id)
            if (fullKb) setDeletingKb(fullKb)
          }}
          canManageKb={canManageKbInList}
          onToggleFavorite={handleToggleFavorite}
          isFavorite={isFavorite}
          isPersonalMode={isPersonalMode}
          personalCreatedByMe={isPersonalMode ? sidebar.personalCreatedByMe : undefined}
          personalSharedWithMe={isPersonalMode ? sidebar.personalSharedWithMe : undefined}
          getKbGroupInfo={sidebar.getKbGroupInfo}
          onMigrateKb={kb => {
            const fullKb =
              sidebar.allKnowledgeBases.find(k => k.id === kb.id) ||
              groupKbs.find(k => k.id === kb.id)
            if (fullKb) setMigratingKb(fullKb)
          }}
          canMigrate={canMigrateKb}
        />
      )
    }

    // Empty state (should not normally reach here with default "All" mode)
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
        <FolderOpen className="w-16 h-16 text-text-muted mb-4" />
        <h2 className="text-lg font-medium text-text-primary mb-2">
          {t('document.tree.emptyState', '请从左侧选择一个知识库')}
        </h2>
        <p className="text-sm text-text-muted max-w-md">
          {t('document.tree.emptyStateHint', '浏览并选择一个知识库以查看详情')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full relative" data-testid="knowledge-document-page">
      {/* Left sidebar */}
      {!isSidebarCollapsed && (
        <div style={{ width: SIDEBAR_WIDTH, flexShrink: 0 }} className="h-full">
          <KnowledgeSidebar
            favorites={sidebar.favorites}
            isFavoritesLoading={sidebar.isFavoritesLoading}
            onAddFavorite={sidebar.addFavorite}
            onRemoveFavorite={sidebar.removeFavorite}
            onReorderFavorites={sidebar.reorderFavorites}
            recentItems={sidebar.recentItems}
            onClearRecent={sidebar.clearRecentAccess}
            groups={sidebar.groups}
            isGroupsLoading={sidebar.isGroupsLoading}
            selectedKbId={sidebar.selectedKbId}
            selectedGroupId={sidebar.selectedGroupId}
            viewMode={sidebar.viewMode}
            onSelectKb={handleSelectKb}
            onSelectGroup={handleSelectGroup}
            onSelectAll={handleSelectAll}
            onSelectGroups={handleSelectGroups}
            onCollapse={() => updateSidebarCollapsed(true)}
          />
        </div>
      )}

      {/* Right content area */}
      <div className="flex-1 min-w-0 flex flex-col bg-base relative">{renderMainContent()}</div>

      {/* Dialogs */}
      <CreateKnowledgeBaseDialog
        open={showCreateDialog}
        onOpenChange={open => {
          if (!isCreating) {
            setShowCreateDialog(open)
            if (!open) {
              setCreateGroupName(undefined)
              setCreateScope('personal')
              setCreateKbType('notebook')
              setShowGroupSelector(false)
            }
          }
        }}
        onSubmit={handleCreate}
        loading={isCreating}
        scope={createScope}
        groupName={createGroupName}
        kbType={createKbType}
        knowledgeDefaultTeamId={knowledgeDefaultTeamId}
        bindModel={knowledgeBindModel}
        showGroupSelector={showGroupSelector}
        availableGroups={availableGroupsForCreate}
        defaultGroupId="personal"
      />
      <EditKnowledgeBaseDialog
        open={!!editingKb}
        onOpenChange={open => !isUpdating && !open && setEditingKb(null)}
        knowledgeBase={editingKb}
        onSubmit={handleUpdate}
        loading={isUpdating}
        knowledgeDefaultTeamId={knowledgeDefaultTeamId}
        bindModel={knowledgeBindModel}
      />

      <DeleteKnowledgeBaseDialog
        open={!!deletingKb}
        onOpenChange={open => !isDeleting && !open && setDeletingKb(null)}
        knowledgeBase={deletingKb}
        onConfirm={handleDelete}
        loading={isDeleting}
      />

      <ShareLinkDialog
        open={!!sharingKb}
        onOpenChange={open => !open && setSharingKb(null)}
        kbId={sharingKb?.id || 0}
        kbName={sharingKb?.name || ''}
      />

      <MigrateKnowledgeBaseDialog
        open={!!migratingKb}
        onOpenChange={open => !isMigrating && !open && setMigratingKb(null)}
        knowledgeBase={migratingKb}
        availableGroups={availableMigrationGroups}
        onMigrate={handleMigrate}
        loading={isMigrating}
      />
    </div>
  )
}
