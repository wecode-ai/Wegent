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
import { FolderOpen } from 'lucide-react'
import { userApis } from '@/apis/user'
import { teamService } from '@/features/tasks/service/teamService'
import { saveGlobalModelPreference, type ModelPreference } from '@/utils/modelPreferences'
import { getModelFromConfig } from '@/features/settings/services/bots'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import { useKnowledgeSidebar, type KnowledgeGroup } from '../hooks/useKnowledgeSidebar'
import { useNamespaceRoleMap } from '../hooks/useNamespaceRoleMap'
import { useGroupKbs } from '../hooks/useGroupKbs'
import { useKnowledgeUrlSync } from '../hooks/useKnowledgeUrlSync'
import { useKnowledgeBaseDialogs } from '../hooks/useKnowledgeBaseDialogs'
import { KnowledgeSidebar } from './KnowledgeSidebar'
import { KnowledgeDetailPanel } from './KnowledgeDetailPanel'
import { KnowledgeGroupListPage, type KbDataItem } from './KnowledgeGroupListPage'
import { DingtalkDocsPage } from './DingtalkDocs'
import { CreateKnowledgeBaseDialog, type AvailableGroup } from './CreateKnowledgeBaseDialog'
import { EditKnowledgeBaseDialog } from './EditKnowledgeBaseDialog'
import { DeleteKnowledgeBaseDialog } from './DeleteKnowledgeBaseDialog'
import { MigrateKnowledgeBaseDialog } from './MigrateKnowledgeBaseDialog'
import {
  canCreateKnowledgeBaseInNamespace,
  canManageKnowledgeBase,
} from '@/utils/namespace-permissions'
import type { KnowledgeBase, KnowledgeBaseWithGroupInfo, SummaryModelRef } from '@/types/knowledge'
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
  const { user } = useUser()

  // Knowledge sidebar hook
  const sidebar = useKnowledgeSidebar()
  const namespaceRoleMap = useNamespaceRoleMap()

  // Group KBs hook (extracted from inline logic)
  const {
    groupKbs,
    isGroupKbsLoading,
    reload: reloadGroupKbs,
  } = useGroupKbs({
    selectedGroupId: sidebar.selectedGroupId,
    groups: sidebar.groups,
    personalCreatedByMe: sidebar.personalCreatedByMe,
    personalSharedWithMe: sidebar.personalSharedWithMe,
  })

  // Sidebar collapse state - auto-collapse when notebook KB is selected
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('knowledge-sidebar-collapsed') === 'true'
    }
    return false
  })

  const updateSidebarCollapsed = useCallback((collapsed: boolean) => {
    setIsSidebarCollapsed(collapsed)
    if (typeof window !== 'undefined') {
      localStorage.setItem('knowledge-sidebar-collapsed', String(collapsed))
      window.dispatchEvent(
        new CustomEvent('knowledge-sidebar-collapse-change', { detail: { collapsed } })
      )
    }
  }, [])

  useEffect(() => {
    const handleCollapseChange = (event: CustomEvent<{ collapsed: boolean }>) => {
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

  // Default teams config for saving model preference
  const [defaultTeamsConfig, setDefaultTeamsConfig] = useState<DefaultTeamsResponse | null>(null)
  const [teams, setTeams] = useState<Team[]>([])

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

  // URL sync and navigation
  const { updateUrlParams, navigateToKb } = useKnowledgeUrlSync({
    initialKbNamespace,
    initialKbName,
    allKnowledgeBases: sidebar.allKnowledgeBases,
    isGroupsLoading: sidebar.isGroupsLoading,
    selectKb: sidebar.selectKb,
    selectGroup: sidebar.selectGroup,
    selectDingtalk: sidebar.selectDingtalk,
  })

  // Handle clear selection event from sidebar
  useEffect(() => {
    const { clearSelection } = sidebar
    const handleClearSelection = () => {
      clearSelection()
      updateUrlParams({ kb: null, group: null })
    }
    window.addEventListener('knowledge-clear-selection', handleClearSelection)
    return () => {
      window.removeEventListener('knowledge-clear-selection', handleClearSelection)
    }
  }, [sidebar, updateUrlParams])

  // Dialog management
  const dialogs = useKnowledgeBaseDialogs({
    sidebar,
    saveSummaryModelToPreference,
    reloadGroupKbs,
  })

  // Auto-collapse sidebar when a notebook KB is selected
  useEffect(() => {
    if (sidebar.selectedKb) {
      if (sidebar.selectedKb.kb_type === 'notebook') {
        updateSidebarCollapsed(true)
      } else {
        updateSidebarCollapsed(false)
      }
    } else {
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

  const handleSelectKb = useCallback(
    (kb: KnowledgeBase | { id: number; name: string; namespace: string }) => {
      const fullKb = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
      if (fullKb) {
        // Only set sidebar selection if we're already on a detail page (initialKbName is defined).
        // When on the main page, skip selectKb to avoid flashing the detail panel
        // before navigation - URL sync on the destination page will handle selection.
        if (initialKbName) {
          sidebar.selectKb(fullKb)
        }
        navigateToKb(fullKb, sidebar.allKnowledgeBasesWithGroupInfo)
      }
    },
    [sidebar, navigateToKb, initialKbName]
  )

  const handleSelectAll = useCallback(() => {
    sidebar.selectAll()
    updateUrlParams({ kb: null, group: null })
  }, [sidebar, updateUrlParams])

  const handleSelectGroup = useCallback(
    (groupId: string) => {
      sidebar.selectGroup(groupId)
      updateUrlParams({ group: groupId, kb: null })
    },
    [sidebar, updateUrlParams]
  )

  const handleBackFromGroup = useCallback(() => {
    sidebar.clearSelection()
    updateUrlParams({ kb: null, group: null })
  }, [sidebar, updateUrlParams])

  const handleSelectGroups = useCallback(() => {
    sidebar.selectGroups()
    updateUrlParams({ kb: null, group: 'all-groups' })
  }, [sidebar, updateUrlParams])

  const handleSelectDingtalk = useCallback(() => {
    sidebar.selectDingtalk()
    updateUrlParams({ kb: null, group: 'dingtalk' })
  }, [sidebar, updateUrlParams])

  const isFavorite = useCallback(
    (kbId: number) => {
      return sidebar.favorites.some(kb => kb.id === kbId)
    },
    [sidebar.favorites]
  )

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

  const availableGroups = useMemo(() => {
    return sidebar.groups.map(g => ({
      id: g.id,
      name: g.name,
      displayName: g.displayName,
    }))
  }, [sidebar.groups])

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

  const allModeKbsWithInfo = useMemo((): KnowledgeBaseWithGroupInfo[] => {
    const map = new Map<number, KnowledgeBaseWithGroupInfo>()
    for (const kb of sidebar.allKnowledgeBasesWithGroupInfo) {
      if (!map.has(kb.id)) {
        map.set(kb.id, { ...kb })
      }
    }
    return Array.from(map.values())
  }, [sidebar.allKnowledgeBasesWithGroupInfo])

  const selectedKbGroupInfo = sidebar.selectedKb
    ? sidebar.getKbGroupInfo(sidebar.selectedKb)
    : undefined

  const handleGroupClick = useCallback(
    (groupId: string, groupType?: string) => {
      let sidebarGroupId: string
      if (groupType === 'personal' || groupId === 'default') {
        sidebarGroupId = 'personal'
      } else if (groupType === 'organization') {
        sidebarGroupId = 'organization'
      } else {
        sidebarGroupId = `group-${groupId}`
      }
      sidebar.selectGroup(sidebarGroupId)
      updateUrlParams({ group: sidebarGroupId, kb: null })
    },
    [sidebar, updateUrlParams]
  )

  const renderMainContent = () => {
    if (sidebar.selectedKb) {
      return (
        <KnowledgeDetailPanel
          selectedKb={sidebar.selectedKb}
          isTreeCollapsed={isSidebarCollapsed}
          onExpandTree={() => updateSidebarCollapsed(false)}
          onEditKb={dialogs.setEditingKb}
          groupInfo={selectedKbGroupInfo}
          onGroupClick={handleGroupClick}
          initialDocPath={initialDocPath}
        />
      )
    }

    if (sidebar.viewMode === 'groups') {
      const teamGroupKbs = sidebar.allKnowledgeBasesWithGroupInfo.filter(
        kb => kb.group_type === 'group'
      )

      return (
        <KnowledgeGroupListPage
          groupId={null}
          groupName={t('document.sidebar.groups', 'Groups')}
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
          onCreateKb={hasCreatableTeamGroup ? dialogs.handleCreateKbFromGroups : undefined}
          onEditKb={kb => {
            const fullKb = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
            if (fullKb) dialogs.setEditingKb(fullKb)
          }}
          onDeleteKb={kb => {
            const fullKb = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
            if (fullKb) dialogs.setDeletingKb(fullKb)
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

    if (sidebar.viewMode === 'dingtalk') {
      if (sidebar.isDingtalkLoading) {
        return (
          <div className="flex-1 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        )
      }
      return (
        <DingtalkDocsPage
          isConfigured={sidebar.isDingtalkConfigured}
          onSyncComplete={() => sidebar.refreshAll()}
        />
      )
    }

    if (sidebar.viewMode === 'all') {
      return (
        <KnowledgeGroupListPage
          groupId={null}
          groupName={t('document.allKnowledgeBases', 'All Knowledge Bases')}
          knowledgeBases={sidebar.allKnowledgeBases}
          knowledgeBasesWithGroupInfo={allModeKbsWithInfo}
          isLoading={sidebar.isGroupsLoading}
          onSelectKb={handleSelectKb}
          onCreateKb={dialogs.handleCreateKbFromAll}
          onEditKb={kb => {
            const fullKb = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
            if (fullKb) dialogs.setEditingKb(fullKb)
          }}
          onDeleteKb={kb => {
            const fullKb = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
            if (fullKb) dialogs.setDeletingKb(fullKb)
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

    if (selectedGroup) {
      const isPersonalMode = selectedGroup.type === 'personal'

      const groupKbsWithInfo = sidebar.allKnowledgeBasesWithGroupInfo.filter(kb => {
        if (selectedGroup.type === 'personal') {
          return kb.group_type === 'personal' || kb.group_type === 'personal-shared'
        } else if (selectedGroup.type === 'organization') {
          return kb.group_type === 'organization'
        } else {
          return kb.group_type === 'group' && kb.group_id === selectedGroup.name
        }
      })

      const groupNativeKbs =
        selectedGroup.type === 'group' ? groupKbsWithInfo.filter(kb => !kb.shared_from) : []
      const groupSharedKbs =
        selectedGroup.type === 'group' ? groupKbsWithInfo.filter(kb => kb.shared_from) : []

      return (
        <KnowledgeGroupListPage
          groupId={selectedGroup.id}
          groupName={selectedGroup.displayName}
          knowledgeBases={groupKbs}
          knowledgeBasesWithGroupInfo={groupKbsWithInfo}
          isLoading={isGroupKbsLoading}
          onBack={handleBackFromGroup}
          onSelectKb={handleSelectKb}
          onCreateKb={canCreateInSelectedGroup ? dialogs.handleCreateKbFromGroup : undefined}
          onEditKb={kb => {
            const fullKb =
              sidebar.allKnowledgeBases.find(k => k.id === kb.id) ||
              groupKbs.find(k => k.id === kb.id)
            if (fullKb) dialogs.setEditingKb(fullKb)
          }}
          onDeleteKb={kb => {
            const fullKb =
              sidebar.allKnowledgeBases.find(k => k.id === kb.id) ||
              groupKbs.find(k => k.id === kb.id)
            if (fullKb) dialogs.setDeletingKb(fullKb)
          }}
          canManageKb={canManageKbInList}
          onToggleFavorite={handleToggleFavorite}
          isFavorite={isFavorite}
          isPersonalMode={isPersonalMode}
          personalCreatedByMe={isPersonalMode ? sidebar.personalCreatedByMe : undefined}
          personalSharedWithMe={isPersonalMode ? sidebar.personalSharedWithMe : undefined}
          groupNativeKbs={groupNativeKbs}
          groupSharedKbs={groupSharedKbs}
          getKbGroupInfo={sidebar.getKbGroupInfo}
          onMigrateKb={kb => {
            const fullKb =
              sidebar.allKnowledgeBases.find(k => k.id === kb.id) ||
              groupKbs.find(k => k.id === kb.id)
            if (fullKb) dialogs.setMigratingKb(fullKb)
          }}
          canMigrate={dialogs.canMigrateKb}
        />
      )
    }

    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
        <FolderOpen className="w-16 h-16 text-text-muted mb-4" />
        <h2 className="text-lg font-medium text-text-primary mb-2">
          {t('document.tree.emptyState', 'Please select a knowledge base from the left')}
        </h2>
        <p className="text-sm text-text-muted max-w-md">
          {t('document.tree.emptyStateHint', 'Browse and select a knowledge base to view details')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full relative" data-testid="knowledge-document-page">
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
            onSelectDingtalk={handleSelectDingtalk}
            dingtalkDocCount={sidebar.dingtalkDocCount}
            isDingtalkConfigured={sidebar.isDingtalkConfigured}
            summary={sidebar.summary}
            allKnowledgeBases={sidebar.allKnowledgeBases}
            onCollapse={() => updateSidebarCollapsed(true)}
          />
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col bg-base relative">{renderMainContent()}</div>

      <CreateKnowledgeBaseDialog
        open={dialogs.showCreateDialog}
        onOpenChange={open => {
          if (!dialogs.isCreating) {
            dialogs.setShowCreateDialog(open)
            if (!open) {
              dialogs.resetCreateDialogState()
            }
          }
        }}
        onSubmit={dialogs.handleCreate}
        loading={dialogs.isCreating}
        scope={dialogs.createScope}
        groupName={dialogs.createGroupName}
        kbType={dialogs.createKbType}
        knowledgeDefaultTeamId={knowledgeDefaultTeamId}
        bindModel={knowledgeBindModel}
        showGroupSelector={dialogs.showGroupSelector}
        availableGroups={availableGroupsForCreate}
        defaultGroupId="personal"
      />
      <EditKnowledgeBaseDialog
        open={!!dialogs.editingKb}
        onOpenChange={open => !dialogs.isUpdating && !open && dialogs.setEditingKb(null)}
        knowledgeBase={dialogs.editingKb}
        onSubmit={dialogs.handleUpdate}
        loading={dialogs.isUpdating}
        knowledgeDefaultTeamId={knowledgeDefaultTeamId}
        bindModel={knowledgeBindModel}
      />

      <DeleteKnowledgeBaseDialog
        open={!!dialogs.deletingKb}
        onOpenChange={open => !dialogs.isDeleting && !open && dialogs.setDeletingKb(null)}
        knowledgeBase={dialogs.deletingKb}
        onConfirm={dialogs.handleDelete}
        loading={dialogs.isDeleting}
      />

      <MigrateKnowledgeBaseDialog
        open={!!dialogs.migratingKb}
        onOpenChange={open => !dialogs.isMigrating && !open && dialogs.setMigratingKb(null)}
        knowledgeBase={dialogs.migratingKb}
        availableGroups={dialogs.availableMigrationGroups}
        onMigrate={dialogs.handleMigrate}
        loading={dialogs.isMigrating}
      />
    </div>
  )
}
