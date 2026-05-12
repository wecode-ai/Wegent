// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Desktop implementation of Knowledge Document Page.
 *
 * Hybrid navigation mode with:
 * - Left sidebar: Search, Favorites, Recent, Groups
 * - Right content area: KB detail or Group list
 *
 * Responsibilities kept here (thin orchestrator):
 * - Sidebar collapse state & event wiring
 * - URL sync on initial load
 * - Navigation helpers (updateUrlParams, navigateToKb)
 * - Selection handlers (handleSelectKb, handleSelectGroup, etc.)
 * - Rendering main content area via renderMainContent()
 * - Composing KnowledgeSidebar + dialogs from useKnowledgeDialogs
 *
 * Extracted sub-modules:
 * - useGroupKbs (hooks/useGroupKbs.ts): group KB loading logic
 * - useKnowledgeDialogs (components/KnowledgeDialogs.tsx): dialog state & CRUD handlers
 */

'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { FolderOpen } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { userApis } from '@/apis/user'
import { teamService } from '@/features/tasks/service/teamService'
import { getModelFromConfig } from '@/features/settings/services/bots'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import { useKnowledgeSidebar, type KnowledgeGroup } from '../hooks/useKnowledgeSidebar'
import { useNamespaceRoleMap } from '../hooks/useNamespaceRoleMap'
import { useGroupKbs } from '../hooks/useGroupKbs'
import { useKnowledgeDialogs } from './KnowledgeDialogs'
import { KnowledgeSidebar } from './KnowledgeSidebar'
import { KnowledgeDetailPanel } from './KnowledgeDetailPanel'
import { KnowledgeGroupListPage, type KbDataItem } from './KnowledgeGroupListPage'
import { DingtalkDocsPage } from './DingtalkDocs'
import type { AvailableGroup } from './CreateKnowledgeBaseDialog'
import type { MigrationTargetGroup } from './MigrateKnowledgeBaseDialog'
import {
  canCreateKnowledgeBaseInNamespace,
  canManageKnowledgeBase,
} from '@/utils/namespace-permissions'
import { buildKbUrl } from '@/utils/knowledgeUrl'
import type { KnowledgeBase, KnowledgeBaseType } from '@/types/knowledge'
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

  // Destructure stable references from sidebar to satisfy exhaustive-deps
  const { clearSelection, allKnowledgeBases } = sidebar

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
      window.dispatchEvent(
        new CustomEvent('knowledge-sidebar-collapse-change', { detail: { collapsed } })
      )
    }
  }, [])

  // Listen for collapse changes from parent components (e.g., TopNavigation expand button)
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

  // Listen for clear selection event from TaskSidebar
  useEffect(() => {
    const handleClearSelection = () => {
      clearSelection()
    }

    window.addEventListener('knowledge-clear-selection', handleClearSelection)

    return () => {
      window.removeEventListener('knowledge-clear-selection', handleClearSelection)
    }
  }, [clearSelection])

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

  // Track if initial URL sync has been done
  const [initialUrlSyncDone, setInitialUrlSyncDone] = useState(false)

  // Sync selected KB or group from URL parameter on initial load only
  useEffect(() => {
    if (initialUrlSyncDone) return
    if (sidebar.isGroupsLoading) return

    // Mode 1: Virtual URL - select KB by namespace + name
    if (initialKbName) {
      let found: (typeof allKnowledgeBases)[0] | undefined

      if (initialKbNamespace) {
        found = allKnowledgeBases.find(
          kb =>
            kb.name.toLowerCase() === initialKbName.toLowerCase() &&
            kb.namespace.toLowerCase() === initialKbNamespace.toLowerCase()
        )
      } else {
        found = allKnowledgeBases.find(kb => kb.name.toLowerCase() === initialKbName.toLowerCase())
      }

      if (found) {
        sidebar.selectKb(found)
      }
      setInitialUrlSyncDone(true)
      return
    }

    // Mode 2: Query params - select KB by id or group
    const kbParam = searchParams.get('kb')
    const groupParam = searchParams.get('group')

    if (kbParam) {
      const kbId = parseInt(kbParam, 10)
      if (!isNaN(kbId)) {
        const found = allKnowledgeBases.find(kb => kb.id === kbId)
        if (found) {
          sidebar.selectKb(found)
        }
      }
    } else if (groupParam === 'dingtalk') {
      // Restore DingTalk mode from URL
      sidebar.selectDingtalk()
    } else if (groupParam) {
      sidebar.selectGroup(groupParam)
    }
    setInitialUrlSyncDone(true)
  }, [
    searchParams,
    allKnowledgeBases,
    sidebar.isGroupsLoading,
    sidebar.selectKb,
    sidebar.selectGroup,
    sidebar.selectDingtalk,
    initialKbNamespace,
    initialKbName,
    initialUrlSyncDone,
  ])

  // Helper function to update URL parameters for group/all navigation
  const updateUrlParams = useCallback(
    (params: { kb?: number | null; group?: string | null }) => {
      if (params.kb !== undefined && params.kb !== null) return

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
      newSearchParams.set('type', 'document')
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
      const kbWithInfo = sidebar.allKnowledgeBasesWithGroupInfo.find(
        k => k.name === kb.name && k.namespace === kb.namespace
      )
      const isOrganization = kbWithInfo?.group_type === 'organization'
      const kbPath = buildKbUrl(kb.namespace, kb.name, isOrganization)
      router.push(kbPath)
    },
    [router, sidebar.allKnowledgeBasesWithGroupInfo]
  )

  // Group KBs loaded via extracted hook
  const { groupKbs, isGroupKbsLoading } = useGroupKbs({
    selectedGroupId: sidebar.selectedGroupId,
    groups: sidebar.groups,
    personalCreatedByMe: sidebar.personalCreatedByMe,
    personalSharedWithMe: sidebar.personalSharedWithMe,
  })

  // Auto-collapse sidebar when a notebook KB is selected
  useEffect(() => {
    if (sidebar.selectedKb) {
      updateSidebarCollapsed(sidebar.selectedKb.kb_type === 'notebook')
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
    if (!selectedGroup) return false
    if (selectedGroup.type === 'personal') return true
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

  // Build available target groups for migration
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

  // Check if KB can be migrated (only personal KBs created by current user)
  const canMigrateKb = useCallback(
    (kb: { id: number; namespace: string; user_id: number }) => {
      if (kb.namespace !== 'default') return false
      return kb.user_id === sidebar.currentUser?.id
    },
    [sidebar.currentUser]
  )

  // Check if KB is favorite
  const isFavorite = useCallback(
    (kbId: number) => sidebar.favorites.some(kb => kb.id === kbId),
    [sidebar.favorites]
  )

  // Toggle favorite
  const { addFavorite, removeFavorite } = sidebar
  const handleToggleFavorite = useCallback(
    async (kbId: number, shouldFavorite: boolean) => {
      if (shouldFavorite) {
        await addFavorite(kbId)
      } else {
        await removeFavorite(kbId)
      }
    },
    [addFavorite, removeFavorite]
  )

  // Dialog state and CRUD handlers via extracted hook
  const { openCreate, openEdit, openDelete, openMigrate, dialogsElement } = useKnowledgeDialogs({
    groups: sidebar.groups,
    selectedGroupId: sidebar.selectedGroupId,
    availableGroupsForCreate,
    availableMigrationGroups,
    knowledgeDefaultTeamId,
    knowledgeBindModel,
    onCreated: sidebar.refreshAll,
    onUpdated: sidebar.refreshAll,
    onDeleted: async (deletedKbId: number) => {
      await sidebar.refreshAll()
      if (deletedKbId === sidebar.selectedKbId) {
        sidebar.clearSelection()
      }
    },
    onMigrated: async (migratedKbId: number) => {
      await sidebar.refreshAll()
      if (migratedKbId === sidebar.selectedKbId) {
        sidebar.clearSelection()
      }
    },
    onReloadGroupKbs: () => {
      // groupKbs is managed by useGroupKbs hook which re-fetches on selectedGroupId change
    },
  })

  // Handle KB selection
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
        navigateToKb(fullKb)
      }
    },
    [sidebar, navigateToKb, initialKbName]
  )

  // Handle "All" selection
  const handleSelectAll = useCallback(() => {
    sidebar.selectAll()
    updateUrlParams({ kb: null, group: null })
  }, [sidebar, updateUrlParams])

  // Handle group selection
  const handleSelectGroup = useCallback(
    (groupId: string) => {
      sidebar.selectGroup(groupId)
      updateUrlParams({ group: groupId, kb: null })
    },
    [sidebar, updateUrlParams]
  )

  // Handle back from group list
  const handleBackFromGroup = useCallback(() => {
    sidebar.clearSelection()
    updateUrlParams({ kb: null, group: null })
  }, [sidebar, updateUrlParams])

  // Handle create KB from group list
  const handleCreateKbFromGroup = useCallback(
    (kbType: KnowledgeBaseType) => {
      if (!selectedGroup) return
      if (selectedGroup.type === 'personal') {
        openCreate(kbType, 'personal')
      } else if (selectedGroup.type === 'organization') {
        openCreate(kbType, 'organization')
      } else {
        openCreate(kbType, 'group', selectedGroup.name)
      }
    },
    [selectedGroup, openCreate]
  )

  // Handle "Groups" selection
  const handleSelectGroups = useCallback(() => {
    sidebar.selectGroups()
    updateUrlParams({ kb: null, group: 'all-groups' })
  }, [sidebar, updateUrlParams])

  // Handle "DingTalk" selection
  const handleSelectDingtalk = useCallback(() => {
    sidebar.selectDingtalk()
    updateUrlParams({ kb: null, group: 'dingtalk' })
  }, [sidebar, updateUrlParams])

  // Handle create KB from "All" page
  const handleCreateKbFromAll = useCallback(
    (kbType: KnowledgeBaseType) => {
      openCreate(kbType, 'personal', undefined, true)
    },
    [openCreate]
  )

  // Handle create KB from "Groups" page
  const handleCreateKbFromGroups = useCallback(
    (kbType: KnowledgeBaseType) => {
      openCreate(kbType, 'group', undefined, true)
    },
    [openCreate]
  )

  // Handle group click from KB detail panel
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

  // Get group info for the selected KB
  const selectedKbGroupInfo = sidebar.selectedKb
    ? sidebar.getKbGroupInfo(sidebar.selectedKb)
    : undefined

  const renderMainContent = () => {
    if (sidebar.viewMode === 'dingtalk') {
      // Wait for DingTalk status to finish loading before rendering
      if (sidebar.isDingtalkLoading) {
        return (
          <div className="flex-1 flex items-center justify-center">
            <Spinner size="lg" />
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

    if (sidebar.selectedKb) {
      return (
        <KnowledgeDetailPanel
          selectedKb={sidebar.selectedKb}
          isTreeCollapsed={isSidebarCollapsed}
          onExpandTree={() => updateSidebarCollapsed(false)}
          onEditKb={openEdit}
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
            if (fullKb) openEdit(fullKb)
          }}
          onDeleteKb={kb => {
            const fullKb = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
            if (fullKb) openDelete(fullKb)
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
            if (fullKb) openEdit(fullKb)
          }}
          onDeleteKb={kb => {
            const fullKb = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
            if (fullKb) openDelete(fullKb)
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
          return kb.group_type === 'personal'
        } else if (selectedGroup.type === 'organization') {
          return kb.group_type === 'organization'
        } else {
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
            if (fullKb) openEdit(fullKb)
          }}
          onDeleteKb={kb => {
            const fullKb =
              sidebar.allKnowledgeBases.find(k => k.id === kb.id) ||
              groupKbs.find(k => k.id === kb.id)
            if (fullKb) openDelete(fullKb)
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
            if (fullKb) openMigrate(fullKb)
          }}
          canMigrate={canMigrateKb}
        />
      )
    }

    // Empty state
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
            onSelectDingtalk={handleSelectDingtalk}
            onCollapse={() => updateSidebarCollapsed(true)}
            dingtalkDocCount={sidebar.dingtalkDocCount}
            isDingtalkConfigured={sidebar.isDingtalkConfigured}
          />
        </div>
      )}

      {/* Right content area */}
      <div className="flex-1 min-w-0 flex flex-col bg-base relative">{renderMainContent()}</div>

      {/* Dialogs */}
      {dialogsElement}
    </div>
  )
}
