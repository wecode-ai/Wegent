// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared knowledge document controller for desktop and mobile layouts.
 *
 * Hybrid navigation mode with:
 * - Left sidebar: Search, Favorites, Recent, Groups
 * - Right content area: KB detail or Group list
 */

'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { ArrowLeft, Menu } from 'lucide-react'
import client from '@/apis/client'
import { Button } from '@/components/ui/button'
import { KnowledgeAccessDialog } from './KnowledgeAccessDialog'
import { usePathname } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { userApis } from '@/apis/user'
import { teamService } from '@/features/tasks/service/teamService'
import { getModelFromConfig } from '@/features/settings/services/bots'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import { parseKbUrl } from '@/utils/knowledgeUrl'
import { useKnowledgeSidebar } from '../hooks/useKnowledgeSidebar'
import {
  hasAdvancedKnowledgeBases,
  useAdvancedKnowledgeMode,
} from '../hooks/useAdvancedKnowledgeMode'
import { useNamespaceRoleState } from '../hooks/useNamespaceRoleMap'
import { useKnowledgeUrlSync } from '../hooks/useKnowledgeUrlSync'
import { useKnowledgeBaseDialogs } from '../hooks/useKnowledgeBaseDialogs'
import { getDefaultKnowledgeView, useKnowledgeViewMode } from '../hooks/useKnowledgeViewMode'
import { KnowledgeSidebar } from './KnowledgeSidebar'
import { CodeWikiWorkspace } from '@/features/knowledge/code-wiki/CodeWikiWorkspace'
import { KnowledgeUrlStatus } from './KnowledgeUrlStatus'
import { KnowledgeDetailPanel } from './KnowledgeDetailPanel'
import { KnowledgeGroupListPage, type KbDataItem } from './KnowledgeGroupListPage'
import { useKnowledgeSourceViews } from '@/features/knowledge/knowledgeSourceViewRegistry'
import { CreateKnowledgeBaseDialog, type AvailableGroup } from './CreateKnowledgeBaseDialog'
import { EditKnowledgeBaseDialog } from './EditKnowledgeBaseDialog'
import { DeleteKnowledgeBaseDialog } from './DeleteKnowledgeBaseDialog'
import { MigrateKnowledgeBaseDialog } from './MigrateKnowledgeBaseDialog'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import type { KnowledgeViewState } from './KnowledgeDocumentPage'
import {
  canCreateKnowledgeBaseInNamespace,
  canManageKnowledgeBase,
} from '@/utils/namespace-permissions'
import type { CodeWikiView, KnowledgeBase } from '@/types/knowledge'
import type { DefaultTeamsResponse, Team } from '@/types/api'

// Sidebar width constant
const SIDEBAR_WIDTH = 280

export interface KnowledgeDocumentWorkspaceProps {
  mobile?: boolean
  /** Initial KB namespace to auto-select (from virtual URL path) */
  initialKbNamespace?: string
  /** Initial KB name to auto-select (from virtual URL path) */
  initialKbName?: string
  /** Initial document path to auto-open (from virtual URL path segments) */
  initialDocPath?: string
  /** Notifies the parent shell so it can render page-level view controls */
  onKnowledgeViewStateChange?: (state: KnowledgeViewState) => void
}

export function KnowledgeDocumentWorkspace(props: KnowledgeDocumentWorkspaceProps = {}) {
  const { user } = useUser()
  const scope = JSON.stringify([user?.id, client.getCacheScope()])
  return <KnowledgeDocumentSession key={scope} {...props} />
}

function KnowledgeDocumentSession({
  mobile = false,
  initialKbNamespace,
  initialKbName,
  initialDocPath,
  onKnowledgeViewStateChange,
}: KnowledgeDocumentWorkspaceProps) {
  const { t } = useTranslation('knowledge')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const createTrigger = useRef<HTMLElement | null>(null)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [accessKbId, setAccessKbId] = useState<number | null>(null)
  const [permissionRevision, setPermissionRevision] = useState(0)
  const { user } = useUser()
  const pathname = usePathname()
  const parsedKbUrl = useMemo(() => {
    if (!pathname || pathname.startsWith('/knowledge/document/')) {
      return null
    }
    return parseKbUrl(pathname)
  }, [pathname])
  const currentDocPath = parsedKbUrl?.docPath ?? initialDocPath

  const { showAdvancedKnowledge, setShowAdvancedKnowledge } = useAdvancedKnowledgeMode()

  // Knowledge sidebar hook
  const sidebar = useKnowledgeSidebar({ showAdvancedKnowledge })
  const visibleKnowledgeBases = sidebar.visibleKnowledgeBases
  const accessKb = sidebar.allKnowledgeBasesWithGroupInfo.find(kb => kb.id === accessKbId)
  useEffect(() => {
    if (
      accessKbId !== null &&
      sidebar.hasLoaded &&
      !sidebar.isGroupsLoading &&
      !sidebar.loadError &&
      !accessKb
    )
      setAccessKbId(null)
  }, [accessKbId, accessKb, sidebar.hasLoaded, sidebar.isGroupsLoading, sidebar.loadError])
  const hasAdvancedKnowledge = useMemo(
    () =>
      getRuntimeConfigSync().enableCodeWiki || hasAdvancedKnowledgeBases(sidebar.allKnowledgeBases),
    [sidebar.allKnowledgeBases]
  )
  const { currentView, setCurrentView } = useKnowledgeViewMode(
    sidebar.selectedKb?.kb_type,
    sidebar.selectedKb?.id
  )
  const verifiedRole =
    sidebar.allKnowledgeBasesWithGroupInfo.find(kb => kb.id === sidebar.selectedKb?.id)
      ?.effective_role ?? undefined
  const selectedKbId = sidebar.selectedKb?.id
  const selectedKbType = sidebar.selectedKb?.kb_type
  const [codeWikiView, setCodeWikiView] = useState<CodeWikiView>('wiki')

  useEffect(() => {
    if (selectedKbType === 'code_wiki') {
      onKnowledgeViewStateChange?.({
        visible: Boolean(selectedKbId),
        switcher: 'code-wiki',
        currentView: codeWikiView,
        onViewChange: view => {
          if (view === 'wiki' || view === 'documents') setCodeWikiView(view)
        },
      })
      return
    }

    onKnowledgeViewStateChange?.({
      visible: Boolean(selectedKbId),
      switcher: 'document',
      currentView,
      onViewChange: view => {
        if (view === 'documents' || view === 'notebook') setCurrentView(view)
      },
    })
  }, [
    codeWikiView,
    currentView,
    onKnowledgeViewStateChange,
    selectedKbId,
    selectedKbType,
    setCurrentView,
  ])

  useEffect(() => {
    setCodeWikiView('wiki')
  }, [selectedKbId])
  const sourceViews = useKnowledgeSourceViews()
  const namespaceRoles = useNamespaceRoleState()
  const namespaceRoleMap = namespaceRoles.roleMap
  const selectedSpace = sidebar.groups.find(group => group.id === sidebar.selectedGroupId)
  const canCreateInSelectedSpace =
    selectedSpace &&
    selectedSpace.type !== 'personal' &&
    canCreateKnowledgeBaseInNamespace({
      namespace: selectedSpace.name,
      namespaceRole: namespaceRoleMap.get(selectedSpace.name),
    })

  // Sidebar collapse state - auto-collapse in Notebook view
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

  const organizationKnowledgeBases = useMemo(() => {
    const namespaces = new Set(
      sidebar.allKnowledgeBasesWithGroupInfo
        .filter(kb => kb.namespace_level === 'organization')
        .map(kb => kb.namespace)
    )
    return sidebar.allKnowledgeBases.filter(kb => namespaces.has(kb.namespace))
  }, [sidebar.allKnowledgeBases, sidebar.allKnowledgeBasesWithGroupInfo])

  // URL sync and navigation
  const {
    initialUrlSyncDone,
    kbResolution,
    retainedKbId,
    updateUrlParams,
    navigateToKbViaHistory,
  } = useKnowledgeUrlSync({
    initialKbNamespace,
    initialKbName,
    scopeKey: sidebar.scopeKey,
    organizationKnowledgeBases,
    hasLoadError: Boolean(sidebar.loadError),
    allKnowledgeBases: sidebar.allKnowledgeBases,
    isGroupsLoading: sidebar.isGroupsLoading,
    selectKb: sidebar.selectKb,
    selectGroup: sidebar.selectGroup,
    selectGroups: sidebar.selectGroups,
    selectSourceView: sidebar.selectSourceView,
    clearSelection: sidebar.clearSelection,
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

  const availableGroupsForCreate = useMemo((): AvailableGroup[] => {
    const spaces = new Map(sidebar.groups.filter(g => g.id !== 'shared').map(g => [g.id, g]))
    for (const group of namespaceRoles.groups) {
      if (!group.is_active) continue
      const existing = [...spaces.values()].find(
        space => space.type !== 'personal' && space.name === group.name
      )
      const id = existing?.id ?? 'group-' + group.name
      spaces.set(id, {
        id,
        name: group.name,
        displayName: group.display_name || group.name,
        type: group.level === 'organization' ? 'organization' : 'group',
        kbCount: 0,
      })
    }
    return [...spaces.values()].map(g => ({
      id: g.id,
      name: g.name,
      displayName: g.displayName,
      type: g.type,
      canCreate:
        g.type === 'personal' ||
        canCreateKnowledgeBaseInNamespace({
          namespace: g.name,
          namespaceRole: namespaceRoleMap.get(g.name),
        }),
    }))
  }, [sidebar.groups, namespaceRoleMap, namespaceRoles.groups])
  const refreshCreationGroups = namespaceRoles.refresh

  // Dialog management
  const dialogs = useKnowledgeBaseDialogs({
    sidebar,
    availableGroups: availableGroupsForCreate,
  })

  const { refreshAll } = sidebar
  // Closing the dialog preserves the owner of writes that are still in flight.
  const permissionResource = accessKbId ?? dialogs.createdKb?.id ?? sidebar.selectedKbId
  const permissionOwner = useRef({ kbId: permissionResource, version: 0 })
  if (permissionResource !== null && permissionResource !== permissionOwner.current.kbId) {
    permissionOwner.current = {
      kbId: permissionResource,
      version: permissionOwner.current.version + 1,
    }
  }
  const permissionVersion = permissionOwner.current.version
  const permissionCacheScope = client.getCacheScope()
  const permissionsChanged = useCallback(() => {
    if (
      !alive.current ||
      permissionOwner.current.version !== permissionVersion ||
      client.getCacheScope() !== permissionCacheScope
    )
      return
    setPermissionRevision(value => value + 1)
    void refreshAll()
  }, [refreshAll, permissionVersion, permissionCacheScope])

  const { dismissCreatedKb } = dialogs
  useEffect(() => {
    if (sidebar.selectedKbId !== null) {
      dismissCreatedKb()
      setAccessKbId(null)
    }
  }, [sidebar.selectedKbId, dismissCreatedKb])
  const permissionKb = dialogs.createdKb ?? accessKb

  // Auto-collapse sidebar in Notebook view.
  useEffect(() => {
    if (sidebar.selectedKb) {
      if (currentView === 'notebook') {
        updateSidebarCollapsed(true)
      } else {
        updateSidebarCollapsed(false)
      }
    } else {
      updateSidebarCollapsed(false)
    }
  }, [sidebar.selectedKb, currentView, updateSidebarCollapsed])

  const canManageKbInList = useCallback(
    (kb: KbDataItem) => {
      return canManageKnowledgeBase({
        currentUserId: user?.id,
        knowledgeBase: kb,
        knowledgeRole: 'my_role' in kb ? (kb.my_role ?? undefined) : undefined,
        namespaceRole: 'my_role' in kb ? undefined : namespaceRoleMap.get(kb.namespace),
      })
    },
    [user?.id, namespaceRoleMap]
  )

  const handleSelectKb = useCallback(
    (kb: KnowledgeBase | { id: number; name: string; namespace: string }) => {
      const fullKb = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
      if (fullKb) {
        const isKbSwitch = fullKb.id !== sidebar.selectedKbId
        // Always update state and URL without causing a page remount to avoid UI flickering.
        // Use history.pushState instead of router.push so Next.js doesn't unmount/remount
        // the entire page component. This works for both the main page and detail pages.
        setNavigationOpen(false)
        sidebar.selectKb(fullKb)
        if (isKbSwitch) {
          setCurrentView(getDefaultKnowledgeView(fullKb.kb_type))
        }
        // Update sidebar collapse synchronously (not via useEffect) so the
        // sidebar state is correct in the same render cycle as the selectedKb update
        updateSidebarCollapsed(fullKb.kb_type !== 'classic')
        navigateToKbViaHistory(fullKb, sidebar.allKnowledgeBasesWithGroupInfo)
      }
    },
    [sidebar, setCurrentView, navigateToKbViaHistory, updateSidebarCollapsed]
  )

  const handleSelectAll = useCallback(() => {
    setNavigationOpen(false)
    sidebar.selectAll()
    updateUrlParams({ kb: null, group: null })
  }, [sidebar, updateUrlParams])

  const handleSelectGroup = useCallback(
    (groupId: string) => {
      setNavigationOpen(false)
      sidebar.selectGroup(groupId)
      updateUrlParams({ group: groupId, kb: null })
    },
    [sidebar, updateUrlParams]
  )

  const handleSelectGroups = useCallback(() => {
    sidebar.selectGroups()
    updateUrlParams({ kb: null, group: 'all-groups' })
  }, [sidebar, updateUrlParams])

  const handleSelectSourceView = useCallback(
    (sourceViewId: string) => {
      setNavigationOpen(false)
      sidebar.selectSourceView(sourceViewId)
      updateUrlParams({ kb: null, group: `source:${sourceViewId}` })
    },
    [sidebar, updateUrlParams]
  )

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

  const allModeKbsWithInfo = visibleKnowledgeBases.allWithGroupInfo

  const selectedKbGroupInfo = sidebar.selectedKb
    ? sidebar.getKbGroupInfo(sidebar.selectedKb)
    : undefined

  const handleGroupClick = useCallback(
    (groupId: string, groupType?: string) => {
      if (groupType === 'unknown') return
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

  const handleKnowledgeBaseTypeConverted = useCallback(
    (updatedKb: KnowledgeBase) => {
      sidebar.syncConvertedKnowledgeBase(updatedKb)
      dialogs.setEditingKb(updatedKb)
    },
    [sidebar, dialogs]
  )

  const retainsDetail =
    sidebar.selectedKb?.id === retainedKbId &&
    retainedKbId !== undefined &&
    (kbResolution?.status === 'loading' || kbResolution?.status === 'error')
  const renderMainContent = () => {
    if (kbResolution && kbResolution.status !== 'resolved' && !retainsDetail) {
      return <KnowledgeUrlStatus status={kbResolution.status} onRetry={sidebar.refreshAll} />
    }
    const expectedKbId =
      kbResolution?.status === 'resolved'
        ? kbResolution.knowledgeBase.id
        : sidebar.detailRequest?.kbId
    if (
      sidebar.viewMode === 'kb' &&
      sidebar.detailRequest?.kbId === expectedKbId &&
      sidebar.detailRequest?.status !== 'ready'
    ) {
      return (
        <KnowledgeUrlStatus
          status={sidebar.detailRequest?.status === 'error' ? 'error' : 'loading'}
          onRetry={sidebar.retrySelectedKb}
        />
      )
    }
    if (
      kbResolution?.status === 'resolved' &&
      sidebar.selectedKb?.id !== kbResolution.knowledgeBase.id
    ) {
      return <KnowledgeUrlStatus status="loading" onRetry={sidebar.refreshAll} />
    }
    // When navigating to a specific KB via URL, show loading until the URL sync
    // completes and selectedKb is set, to avoid flashing the list page
    if (initialKbName && !sidebar.selectedKb && !initialUrlSyncDone) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <Spinner size="lg" />
        </div>
      )
    }

    if (sidebar.viewMode === 'source' && sidebar.selectedSourceViewId) {
      const sourceView = sourceViews.find(view => view.id === sidebar.selectedSourceViewId)
      if (sourceView) {
        return sourceView.renderView()
      }
      return (
        <div className="flex-1 flex items-center justify-center">
          <Spinner size="lg" />
        </div>
      )
    }

    if (sidebar.selectedKb) {
      // A code wiki is a knowledge base like any other and lives at the same URL.
      // What differs is how it is read: a page tree, a page, and its outline, rather
      // than a document workspace. Deciding that here rather than on a route of its
      // own is what keeps one knowledge base from having two addresses — the second
      // one needed a redirect, and that redirect lost a race with this page's own
      // history.pushState and rendered the wiki as a notebook anyway.
      if (sidebar.selectedKb.kb_type === 'code_wiki') {
        return (
          <CodeWikiWorkspace
            key={sidebar.selectedKb.id}
            wiki={sidebar.selectedKb}
            permissionRefreshKey={permissionRevision}
            verifiedRole={verifiedRole}
            onPermissionsChanged={permissionsChanged}
            onAccessLost={() => sidebar.removeInaccessibleKnowledgeBase(sidebar.selectedKb!.id)}
            view={codeWikiView}
            onConfigure={() => dialogs.setEditingKb(sidebar.selectedKb!)}
            groupInfo={selectedKbGroupInfo}
            onGroupClick={handleGroupClick}
          />
        )
      }

      return (
        <KnowledgeDetailPanel
          key={`${sidebar.selectedKb.id}-${currentDocPath ?? ''}`}
          selectedKb={sidebar.selectedKb}
          verifiedRole={verifiedRole}
          permissionRefreshKey={permissionRevision}
          onPermissionsChanged={permissionsChanged}
          onAccessLost={() => sidebar.removeInaccessibleKnowledgeBase(sidebar.selectedKb!.id)}
          onSyncKnowledgeBase={sidebar.syncKnowledgeBase}
          isTreeCollapsed={isSidebarCollapsed}
          onExpandTree={() => updateSidebarCollapsed(false)}
          onEditKb={dialogs.setEditingKb}
          groupInfo={selectedKbGroupInfo}
          onGroupClick={handleGroupClick}
          initialDocPath={currentDocPath}
          currentView={currentView}
        />
      )
    }

    const rows =
      sidebar.selectedGroupId === 'personal'
        ? visibleKnowledgeBases.personalCreatedByMe
        : sidebar.selectedGroupId === 'shared'
          ? visibleKnowledgeBases.personalSharedWithMe
          : sidebar.selectedGroupId === 'organization'
            ? allModeKbsWithInfo.filter(kb => kb.namespace_level === 'organization')
            : sidebar.viewMode === 'groups'
              ? allModeKbsWithInfo.filter(kb => kb.team_ids?.length)
              : allModeKbsWithInfo
    const titleKey =
      sidebar.selectedGroupId === 'personal'
        ? 'created'
        : sidebar.selectedGroupId === 'shared'
          ? 'shared'
          : sidebar.selectedGroupId === 'organization'
            ? 'company'
            : 'all'
    return (
      <KnowledgeGroupListPage
        mobile={mobile}
        onViewPermissions={kb => setAccessKbId(kb.id)}
        groupId={sidebar.selectedGroupId}
        groupName={t('document.navigation.' + titleKey)}
        knowledgeBases={visibleKnowledgeBases.all}
        knowledgeBasesWithGroupInfo={rows}
        isLoading={sidebar.isGroupsLoading && !sidebar.hasLoaded}
        onSelectKb={handleSelectKb}
        onCreateKb={type => {
          createTrigger.current = document.activeElement as HTMLElement
          dialogs.handleCreateKbFromAll(type)
        }}
        onCreateKbInSpace={
          canCreateInSelectedSpace
            ? type => {
                createTrigger.current = document.activeElement as HTMLElement
                dialogs.handleCreateKbFromGroup(type)
              }
            : undefined
        }
        hasAdvancedKnowledge={hasAdvancedKnowledge}
        showAdvancedKnowledge={showAdvancedKnowledge}
        onShowAdvancedKnowledgeChange={setShowAdvancedKnowledge}
        onEditKb={kb => {
          const full = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
          if (full) dialogs.setEditingKb(full)
        }}
        onDeleteKb={kb => {
          const full = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
          if (full) dialogs.setDeletingKb(full)
        }}
        canManageKb={canManageKbInList}
        onToggleFavorite={handleToggleFavorite}
        isFavorite={isFavorite}
        getKbGroupInfo={sidebar.getKbGroupInfo}
        isAllMode
        showCompanySpace={sidebar.viewMode === 'all'}
        filterGroupId={sidebar.filterGroupId}
        onFilterGroupChange={sidebar.setFilterGroupId}
        availableGroups={availableGroups.filter(g => g.id.startsWith('group-'))}
        onMigrateKb={kb => {
          const full = sidebar.allKnowledgeBases.find(k => k.id === kb.id)
          if (full) dialogs.setMigratingKb(full)
        }}
        canMigrate={dialogs.canMigrateKb}
      />
    )
  }

  return (
    <div
      className={`flex h-full relative ${mobile ? 'flex-col' : ''}`}
      data-testid={mobile ? 'knowledge-document-page-mobile' : 'knowledge-document-page'}
    >
      {mobile && !sidebar.selectedKb && (
        <Button
          variant="ghost"
          className="min-h-11 min-w-11 shrink-0 self-start"
          data-testid="knowledge-mobile-navigation-toggle"
          aria-expanded={navigationOpen}
          onClick={() => setNavigationOpen(value => !value)}
        >
          <Menu className="h-5 w-5" />
          {t('document.navigation.browse')}
        </Button>
      )}
      {mobile &&
        sidebar.selectedKb &&
        (sidebar.selectedKb.kb_type !== 'code_wiki' || codeWikiView === 'documents') && (
          <Button
            variant="ghost"
            className="min-h-11 min-w-11 shrink-0 self-start"
            data-testid="knowledge-detail-back-button"
            aria-label={t('document.backToList')}
            onClick={handleSelectAll}
          >
            <ArrowLeft className="h-5 w-5" />
            {t('document.backToList')}
          </Button>
        )}
      {((!mobile && !isSidebarCollapsed) || (mobile && !sidebar.selectedKb && navigationOpen)) && (
        <div
          style={{ width: mobile ? '100%' : SIDEBAR_WIDTH, flexShrink: 0 }}
          className={mobile ? 'max-h-[60dvh] overflow-auto border-b border-border' : 'h-full'}
        >
          <KnowledgeSidebar
            key={sidebar.scopeKey}
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
            selectedSourceViewId={sidebar.selectedSourceViewId}
            onSelectKb={handleSelectKb}
            onSelectGroup={handleSelectGroup}
            onSelectAll={handleSelectAll}
            onSelectGroups={handleSelectGroups}
            onSelectSourceView={handleSelectSourceView}
            sourceViews={sourceViews}
            summary={sidebar.summary}
            allKnowledgeBases={visibleKnowledgeBases.all}
            onCollapse={() => (mobile ? setNavigationOpen(false) : updateSidebarCollapsed(true))}
          />
        </div>
      )}

      <div className="flex-1 min-h-0 min-w-0 flex flex-col bg-base relative">
        {sidebar.loadError && !kbResolution && (
          <div role="alert" className="p-3 text-error">
            {t('document.navigation.loadFailed')}
            <button
              type="button"
              data-testid="retry-knowledge-navigation"
              className="min-h-11 min-w-11 px-3"
              onClick={() => void sidebar.refreshAll()}
            >
              {t('document.navigation.retry')}
            </button>
          </div>
        )}
        {retainsDetail && kbResolution?.status === 'error' && (
          <KnowledgeUrlStatus status="error" onRetry={sidebar.refreshAll} compact />
        )}
        {sidebar.loadError && !sidebar.hasLoaded && !kbResolution ? null : renderMainContent()}
      </div>

      {permissionKb && (
        <KnowledgeAccessDialog
          kbId={permissionKb.id}
          kbNamespace={permissionKb.namespace}
          resourceCreated={Boolean(dialogs.createdKb)}
          restoreFocus={() => {
            if (createTrigger.current?.isConnected) createTrigger.current.focus()
          }}
          refreshError={dialogs.createdKb ? dialogs.createRefreshError || sidebar.loadError : null}
          onRetryRefresh={() => void dialogs.retryCreatedList()}
          onClose={() => {
            setAccessKbId(null)
            dialogs.dismissCreatedKb()
          }}
          onChanged={permissionsChanged}
          onAccessLost={() => {
            sidebar.removeInaccessibleKnowledgeBase(permissionKb.id)
            dialogs.dismissCreatedKb()
          }}
        />
      )}
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
        defaultGroupId={dialogs.defaultCreateGroupId}
        onRefreshGroups={refreshCreationGroups}
        groupsLoading={namespaceRoles.loading}
        groupsFailed={namespaceRoles.failed}
      />
      <EditKnowledgeBaseDialog
        open={!!dialogs.editingKb}
        onOpenChange={open => !open && dialogs.setEditingKb(null)}
        knowledgeBase={dialogs.editingKb}
        onSubmit={dialogs.handleUpdate}
        onTypeConverted={handleKnowledgeBaseTypeConverted}
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
