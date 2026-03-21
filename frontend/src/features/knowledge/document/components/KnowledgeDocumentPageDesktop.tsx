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
import { useSearchParams } from 'next/navigation'
import { FolderOpen } from 'lucide-react'
import { userApis } from '@/apis/user'
import { teamService } from '@/features/tasks/service/teamService'
import { saveGlobalModelPreference, type ModelPreference } from '@/utils/modelPreferences'
import { useTranslation } from '@/hooks/useTranslation'
import { listKnowledgeBases } from '@/apis/knowledge'
import { useKnowledgeSidebar, type KnowledgeGroup } from '../hooks/useKnowledgeSidebar'
import { KnowledgeSidebar } from './KnowledgeSidebar'
import { KnowledgeDetailPanel } from './KnowledgeDetailPanel'
import { KnowledgeGroupListPage } from './KnowledgeGroupListPage'
import { CreateKnowledgeBaseDialog, type AvailableGroup } from './CreateKnowledgeBaseDialog'
import { EditKnowledgeBaseDialog } from './EditKnowledgeBaseDialog'
import { DeleteKnowledgeBaseDialog } from './DeleteKnowledgeBaseDialog'
import { ShareLinkDialog } from '../../permission/components/ShareLinkDialog'
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

export function KnowledgeDocumentPageDesktop() {
  const { t } = useTranslation('knowledge')
  const searchParams = useSearchParams()

  // Knowledge sidebar hook
  const sidebar = useKnowledgeSidebar()

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
  }, [sidebar])

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

  // Loading states for dialogs
  const [isCreating, setIsCreating] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

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

  // Find knowledge mode default team ID
  const knowledgeDefaultTeamId = useMemo(() => {
    if (!defaultTeamsConfig?.knowledge || teams.length === 0) return null

    const { name, namespace } = defaultTeamsConfig.knowledge
    const normalizedNamespace = namespace || 'default'

    const matchedTeam = teams.find(team => {
      const teamNamespace = team.namespace || 'default'
      return team.name === name && teamNamespace === normalizedNamespace
    })

    return matchedTeam?.id ?? null
  }, [defaultTeamsConfig, teams])

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

  // Sync selected KB from URL parameter
  useEffect(() => {
    const kbParam = searchParams.get('kb')
    if (kbParam) {
      const kbId = parseInt(kbParam, 10)
      if (!isNaN(kbId) && kbId !== sidebar.selectedKbId) {
        const found = sidebar.allKnowledgeBases.find(kb => kb.id === kbId)
        if (found) {
          sidebar.selectKb(found)
        }
      }
    }
  }, [searchParams, sidebar.allKnowledgeBases, sidebar.selectedKbId, sidebar.selectKb])

  // Load group KBs when a group is selected
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
          // Personal KBs are already in allKnowledgeBases
          kbs = sidebar.allKnowledgeBases.filter(kb => kb.namespace === 'default' || !kb.namespace)
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
  }, [sidebar.selectedGroupId, sidebar.groups, sidebar.allKnowledgeBases])
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

  // Handle KB selection (supports both KnowledgeBase and KnowledgeBaseWithGroupInfo)
  const handleSelectKb = useCallback(
    (kb: KnowledgeBase | { id: number; name: string; namespace: string }) => {
      // Find the full KB from allKnowledgeBases to ensure we have all fields
      const fullKb = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
      if (fullKb) {
        sidebar.selectKb(fullKb)
      }
    },
    [sidebar]
  )

  // Handle "All" selection
  const handleSelectAll = useCallback(() => {
    sidebar.selectAll()
  }, [sidebar])

  // Handle group selection
  const handleSelectGroup = useCallback(
    (groupId: string) => {
      sidebar.selectGroup(groupId)
    },
    [sidebar]
  )

  // Handle back from group list
  const handleBackFromGroup = useCallback(() => {
    sidebar.clearSelection()
  }, [sidebar])

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
  // Handle KB created
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

        // Save model preference for notebook type
        if (kbType === 'notebook' && data.summary_enabled && data.summary_model_ref) {
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

        if (editingKb.kb_type === 'notebook' && data.summary_enabled && data.summary_model_ref) {
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

  // Handle create KB from "All" page
  const handleCreateKbFromAll = useCallback((kbType: KnowledgeBaseType) => {
    // Show group selector when creating from "All" page
    setCreateScope('personal')
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
      canCreate: true, // TODO: Check actual permission
    }))
  }, [sidebar.groups])

  // Get group info for the selected KB
  const selectedKbGroupInfo = useMemo(() => {
    if (!sidebar.selectedKb) return undefined
    return sidebar.getKbGroupInfo(sidebar.selectedKb)
  }, [sidebar.selectedKb, sidebar.getKbGroupInfo])

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
    },
    [sidebar]
  )

  // Render main content area
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
      return (
        <KnowledgeGroupListPage
          groupId={selectedGroup.id}
          groupName={selectedGroup.displayName}
          knowledgeBases={groupKbs}
          isLoading={isGroupKbsLoading}
          onBack={handleBackFromGroup}
          onSelectKb={handleSelectKb}
          onCreateKb={handleCreateKbFromGroup}
          onEditKb={kb => {
            const fullKb = groupKbs.find(k => k.id === kb.id)
            if (fullKb) setEditingKb(fullKb)
          }}
          onDeleteKb={kb => {
            const fullKb = groupKbs.find(k => k.id === kb.id)
            if (fullKb) setDeletingKb(fullKb)
          }}
          onToggleFavorite={handleToggleFavorite}
          isFavorite={isFavorite}
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
            isAdmin={sidebar.isAdmin}
            onCollapse={() => updateSidebarCollapsed(true)}
          />
        </div>
      )}

      {/* Right content area */}
      <div className="flex-1 min-w-0 flex flex-col bg-base relative">{renderMainContent()}</div>

      {/* Dialogs */}
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
    </div>
  )
}
