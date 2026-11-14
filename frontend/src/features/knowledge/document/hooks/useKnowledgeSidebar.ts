// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useKnowledgeSidebar - Hook for managing knowledge sidebar state.
 *
 * Combines favorites, recent access, and groups data for the sidebar.
 * Uses the optimized all-grouped API to solve N+1 query problem.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import client, { ApiError } from '@/apis/client'
import { useTranslation } from '@/hooks/useTranslation'
import { collectNavigationKnowledge, type NavigationKnowledgeBase } from '../navigation'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { getKnowledgeBase } from '@/apis/knowledge'
import { useUser } from '@/features/common/UserContext'
import { documentViewOf } from '@/types/knowledge'
import type {
  KnowledgeBase,
  AllGroupedKnowledgeResponse,
  KnowledgeBaseWithGroupInfo,
  KbGroupInfo,
} from '@/types/knowledge'
import type { KbDataItem } from '../components/KnowledgeGroupListPage'
import type { Group } from '@/types/group'
import type { User } from '@/types/api'
import { filterKnowledgeBasesByAdvancedMode } from './useAdvancedKnowledgeMode'

// Storage keys
const RECENT_STORAGE_KEY = 'knowledge-recent-access'
const MAX_RECENT_ITEMS = 5

export type GroupType = 'personal' | 'group' | 'organization'

/** View mode for the knowledge page */
export type ViewMode = 'all' | 'group' | 'kb' | 'groups' | 'source'

export interface KnowledgeGroup {
  id: string
  type: GroupType
  name: string
  displayName: string
  kbCount: number
  group?: Group
}

export interface RecentAccessItem {
  kbId: number
  kbName: string
  kbType: 'notebook' | 'classic'
  namespace: string
  accessedAt: number
}

// Re-export KbGroupInfo from types for convenience
export type { KbGroupInfo } from '@/types/knowledge'

export interface VisibleKnowledgeBases {
  all: KnowledgeBase[]
  allWithGroupInfo: NavigationKnowledgeBase[]
  personalCreatedByMe: NavigationKnowledgeBase[]
  personalSharedWithMe: NavigationKnowledgeBase[]
}

export interface UseKnowledgeSidebarReturn {
  // Favorites
  favorites: KnowledgeBase[]
  isFavoritesLoading: boolean
  addFavorite: (kbId: number) => Promise<void>
  removeFavorite: (kbId: number) => Promise<void>
  reorderFavorites: (kbIds: number[]) => Promise<void>

  // Recent access
  recentItems: KnowledgeBase[]
  addRecentAccess: (kb: KnowledgeBase) => void
  clearRecentAccess: () => void

  // Groups
  groups: KnowledgeGroup[]
  isGroupsLoading: boolean

  // Selection
  selectedKbId: number | null
  selectedGroupId: string | null
  selectedSourceViewId: string | null
  selectedKb: KnowledgeBase | null
  detailRequest: { kbId: number; status: 'loading' | 'ready' | 'error' } | null
  retrySelectedKb: () => void
  selectKb: (kb: KnowledgeBase) => void
  syncKnowledgeBase: (kb: KnowledgeBase) => void
  syncConvertedKnowledgeBase: (kb: KnowledgeBase) => void
  selectGroup: (groupId: string) => void
  selectGroups: () => void
  selectSourceView: (sourceViewId: string) => void
  clearSelection: () => void
  removeInaccessibleKnowledgeBase: (kbId: number) => void

  // View mode
  viewMode: ViewMode
  selectAll: () => void
  filterGroupId: string | null
  setFilterGroupId: (groupId: string | null) => void

  // Raw KBs for navigation and ID lookups
  allKnowledgeBases: KnowledgeBase[]
  allKnowledgeBasesWithGroupInfo: NavigationKnowledgeBase[]
  // Filtered KBs for display
  visibleKnowledgeBases: VisibleKnowledgeBases

  // Get group info for a KB (accepts both KnowledgeBase and KnowledgeBaseWithGroupInfo)
  getKbGroupInfo: (kb: KbDataItem) => KbGroupInfo

  // Current user
  currentUser: User | null

  // Summary counts from backend
  summary?: {
    total_count: number
    personal_count: number
    group_count: number
    organization_count: number
  }

  scopeKey: string
  loadError: string | null
  listRevision: number
  hasLoaded: boolean
  // Refresh
  refreshAll: () => Promise<void>
}

/**
 * Load recent access from localStorage
 */
function loadRecentAccess(key: string): RecentAccessItem[] {
  try {
    const saved = localStorage.getItem(key)
    return saved ? JSON.parse(saved) : []
  } catch {
    return []
  }
}

/**
 * Save recent access to localStorage
 */
function saveRecentAccess(key: string, items: RecentAccessItem[]) {
  try {
    localStorage.setItem(key, JSON.stringify(items))
  } catch {
    // Ignore storage errors
  }
}

/**
 * Convert KnowledgeBaseWithGroupInfo to KnowledgeBase
 */
function toKnowledgeBase(kb: KnowledgeBaseWithGroupInfo): KnowledgeBase {
  return {
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
  }
}

function mergeKnowledgeBase(
  existing: KnowledgeBaseWithGroupInfo,
  updated: KnowledgeBase
): KnowledgeBaseWithGroupInfo {
  return {
    ...existing,
    name: updated.name,
    description: updated.description,
    namespace: updated.namespace,
    document_count: updated.document_count,
    kb_type: updated.kb_type || existing.kb_type,
    user_id: updated.user_id,
    updated_at: updated.updated_at,
    created_at: updated.created_at,
  }
}

export function useKnowledgeSidebar({
  showAdvancedKnowledge = false,
}: {
  showAdvancedKnowledge?: boolean
} = {}): UseKnowledgeSidebarReturn {
  const { user } = useUser()
  const { t } = useTranslation('knowledge')
  const scope = JSON.stringify([user?.id, client.getCacheScope()])
  const recentKey = `${RECENT_STORAGE_KEY}:${scope}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const [stateScope, setStateScope] = useState(scope)
  const requestRef = useRef(0)
  const latestSelectedKbIdRef = useRef<number | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [listRevision, setListRevision] = useState(0)
  const [hasLoaded, setHasLoaded] = useState(false)

  // Data state - using the new all-grouped API response
  const [allGroupedData, setAllGroupedData] = useState<AllGroupedKnowledgeResponse | null>(null)

  // Loading state
  const [isLoading, setIsLoading] = useState(true)
  const [isFavoritesLoading, setIsFavoritesLoading] = useState(false)

  // Favorites state (will be loaded from API when backend is ready)
  const [favorites, setFavorites] = useState<KnowledgeBase[]>([])

  // Recent access state
  const [recentAccessItems, setRecentAccessItems] = useState<RecentAccessItem[]>(() =>
    loadRecentAccess(recentKey)
  )

  // Selection state
  const [selectedKbId, setSelectedKbId] = useState<number | null>(null)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [selectedSourceViewId, setSelectedSourceViewId] = useState<string | null>(null)
  const [selectedKb, setSelectedKb] = useState<KnowledgeBase | null>(null)

  const [detailRequest, setDetailRequest] = useState<{
    kbId: number
    status: 'loading' | 'ready' | 'error'
  } | null>(null)
  const detailVersion = useRef(0)

  // View mode state
  const [viewMode, setViewMode] = useState<ViewMode>('all')
  const [filterGroupId, setFilterGroupId] = useState<string | null>(null)

  if (stateScope !== scope) {
    latestSelectedKbIdRef.current = null
    setDetailRequest(null)
    detailVersion.current++
    setStateScope(scope)
    setAllGroupedData(null)
    setSelectedKbId(null)
    setSelectedKb(null)
    setSelectedGroupId(null)
    setSelectedSourceViewId(null)
    setViewMode('all')
    setFilterGroupId(null)
    setFavorites([])
    setRecentAccessItems(loadRecentAccess(recentKey))
    setIsLoading(true)
    setHasLoaded(false)
    setListRevision(0)
    setLoadError(null)
  }

  const loadInitialData = useCallback(async () => {
    if (scopeRef.current !== scope) return
    const request = ++requestRef.current
    const current = () => scopeRef.current === scope && requestRef.current === request
    setIsLoading(true)
    setLoadError(null)
    try {
      const response = await knowledgeBaseApi.getAllGrouped()
      if (!current()) return
      setAllGroupedData(response)
      setHasLoaded(true)
      setListRevision(value => value + 1)
      const ids = new Set(collectNavigationKnowledge(response).map(kb => kb.id))
      if (latestSelectedKbIdRef.current !== null && !ids.has(latestSelectedKbIdRef.current))
        latestSelectedKbIdRef.current = null
      setSelectedKb(prev => (prev && ids.has(prev.id) ? prev : null))
      setSelectedKbId(prev => (prev !== null && ids.has(prev) ? prev : null))
    } catch (error) {
      if (current()) setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      if (current()) setIsLoading(false)
    }
  }, [scope])

  useEffect(() => {
    if (user) void loadInitialData()
    else setIsLoading(false)
    return () => {
      requestRef.current++
    }
  }, [user?.id, loadInitialData])

  const allKnowledgeBasesWithGroupInfo = useMemo(
    () => (allGroupedData ? collectNavigationKnowledge(allGroupedData) : []),
    [allGroupedData]
  )
  const allKnowledgeBases = useMemo(
    () => allKnowledgeBasesWithGroupInfo.map(toKnowledgeBase),
    [allKnowledgeBasesWithGroupInfo]
  )
  const personalCreatedByMeRaw = useMemo(
    () =>
      allKnowledgeBasesWithGroupInfo.filter(
        kb => kb.user_id === user?.id && kb.namespace_level !== 'organization'
      ),
    [allKnowledgeBasesWithGroupInfo, user?.id]
  )
  const personalSharedWithMeRaw = useMemo(
    () =>
      allKnowledgeBasesWithGroupInfo.filter(
        kb => kb.user_id !== user?.id && kb.namespace_level !== 'organization'
      ),
    [allKnowledgeBasesWithGroupInfo, user?.id]
  )

  const visibleKnowledgeBases = useMemo<VisibleKnowledgeBases>(
    () => ({
      all: filterKnowledgeBasesByAdvancedMode(allKnowledgeBases, showAdvancedKnowledge),
      allWithGroupInfo: filterKnowledgeBasesByAdvancedMode(
        allKnowledgeBasesWithGroupInfo,
        showAdvancedKnowledge
      ),
      personalCreatedByMe: filterKnowledgeBasesByAdvancedMode(
        personalCreatedByMeRaw,
        showAdvancedKnowledge
      ),
      personalSharedWithMe: filterKnowledgeBasesByAdvancedMode(
        personalSharedWithMeRaw,
        showAdvancedKnowledge
      ),
    }),
    [
      allKnowledgeBases,
      allKnowledgeBasesWithGroupInfo,
      personalCreatedByMeRaw,
      personalSharedWithMeRaw,
      showAdvancedKnowledge,
    ]
  )

  const getKbGroupInfo = useCallback(
    (kb: KbDataItem): KbGroupInfo => {
      const row = allKnowledgeBasesWithGroupInfo.find(item => item.id === kb.id)
      return {
        groupId: kb.namespace,
        groupName:
          row?.namespace_display_name ||
          t(
            kb.namespace === 'default'
              ? 'document.navigation.personalSpace'
              : 'document.navigation.unknownSpace'
          ),
        groupType:
          row?.namespace_level === 'organization'
            ? 'organization'
            : row?.namespace_level === 'personal'
              ? 'personal'
              : row?.namespace_level === 'group'
                ? 'group'
                : 'unknown',
      }
    },
    [allKnowledgeBasesWithGroupInfo, t]
  )

  const visibleCounts = useMemo(() => {
    const rows = visibleKnowledgeBases.allWithGroupInfo
    return {
      groupCounts: new Map(
        allGroupedData?.groups.map(group => [
          group.group_name,
          rows.filter(kb => kb.team_ids?.includes(group.group_name)).length,
        ]) ?? []
      ),
      summary: {
        total_count: rows.length,
        personal_count: visibleKnowledgeBases.personalCreatedByMe.length,
        group_count: rows.filter(kb => kb.team_ids?.length).length,
        organization_count: rows.filter(kb => kb.namespace_level === 'organization').length,
      },
    }
  }, [allGroupedData, visibleKnowledgeBases])

  // Build groups list with KB counts
  const groups = useMemo((): KnowledgeGroup[] => {
    if (!allGroupedData) return []

    const result: KnowledgeGroup[] = []

    // Personal group
    result.push({
      id: 'personal',
      type: 'personal',
      name: 'personal',
      displayName: t('document.navigation.personalSpace'),
      kbCount: visibleCounts.summary.personal_count,
    })

    result.push({
      id: 'shared',
      type: 'personal',
      name: 'shared',
      displayName: t('document.navigation.shared'),
      kbCount: visibleKnowledgeBases.personalSharedWithMe.length,
    })

    const companyNamespaces = new Set([
      allGroupedData.organization.namespace,
      ...allKnowledgeBasesWithGroupInfo
        .filter(kb => kb.namespace_level === 'organization')
        .map(kb => kb.namespace),
    ])
    const teamNames = new Map(
      allGroupedData.groups
        .filter(group => !companyNamespaces.has(group.group_name))
        .map(group => [group.group_name, group.group_display_name || group.group_name])
    )
    teamNames.forEach((displayName, name) => {
      result.push({
        id: 'group-' + name,
        type: 'group',
        name,
        displayName,
        kbCount: visibleKnowledgeBases.allWithGroupInfo.filter(kb => kb.team_ids?.includes(name))
          .length,
      })
    })

    // Organization group
    result.push({
      id: 'organization',
      type: 'organization',
      name: allGroupedData.organization.namespace || 'organization',
      displayName: allGroupedData.organization.display_name || t('document.navigation.company'),
      kbCount: visibleCounts.summary.organization_count,
    })

    return result
  }, [allGroupedData, allKnowledgeBasesWithGroupInfo, visibleCounts, visibleKnowledgeBases, t])

  // Convert recent access items to KnowledgeBase objects
  const recentItems = useMemo(() => {
    return recentAccessItems
      .map(item => visibleKnowledgeBases.all.find(kb => kb.id === item.kbId))
      .filter((kb): kb is KnowledgeBase => kb !== undefined)
      .slice(0, MAX_RECENT_ITEMS)
  }, [recentAccessItems, visibleKnowledgeBases])

  // Favorites management (placeholder - will use API when backend is ready)
  const addFavorite = useCallback(
    async (kbId: number) => {
      setIsFavoritesLoading(true)
      try {
        // TODO: Call API when backend is ready
        // await knowledgeBaseApi.addFavorite(kbId)
        const kb = allKnowledgeBases.find(k => k.id === kbId)
        if (kb) {
          setFavorites(prev => [...prev, kb])
        }
      } finally {
        setIsFavoritesLoading(false)
      }
    },
    [allKnowledgeBases]
  )

  const removeFavorite = useCallback(async (kbId: number) => {
    setIsFavoritesLoading(true)
    try {
      // TODO: Call API when backend is ready
      // await knowledgeBaseApi.removeFavorite(kbId)
      setFavorites(prev => prev.filter(kb => kb.id !== kbId))
    } finally {
      setIsFavoritesLoading(false)
    }
  }, [])

  const reorderFavorites = useCallback(async (kbIds: number[]) => {
    setIsFavoritesLoading(true)
    try {
      // TODO: Call API when backend is ready
      // await knowledgeBaseApi.reorderFavorites(kbIds)
      setFavorites(prev => {
        const kbMap = new Map(prev.map(kb => [kb.id, kb]))
        return kbIds.map(id => kbMap.get(id)).filter((kb): kb is KnowledgeBase => kb !== undefined)
      })
    } finally {
      setIsFavoritesLoading(false)
    }
  }, [])

  // Recent access management
  const addRecentAccess = useCallback(
    (kb: KnowledgeBase) => {
      setRecentAccessItems(prev => {
        const filtered = prev.filter(item => item.kbId !== kb.id)
        const newItem: RecentAccessItem = {
          kbId: kb.id,
          kbName: kb.name,
          kbType: documentViewOf(kb.kb_type) ?? 'notebook',
          namespace: kb.namespace,
          accessedAt: Date.now(),
        }
        const updated = [newItem, ...filtered].slice(0, MAX_RECENT_ITEMS)
        saveRecentAccess(recentKey, updated)
        return updated
      })
    },
    [recentKey]
  )

  const clearRecentAccess = useCallback(() => {
    setRecentAccessItems([])
    saveRecentAccess(recentKey, [])
  }, [recentKey])

  // Selection management
  const selectKb = useCallback(
    (kb: KnowledgeBase) => {
      // Record the intended selection before starting any async work
      if (
        latestSelectedKbIdRef.current === kb.id &&
        detailRequest?.kbId === kb.id &&
        detailRequest.status === 'ready'
      )
        return
      const version = ++detailVersion.current
      setDetailRequest({ kbId: kb.id, status: 'loading' })
      latestSelectedKbIdRef.current = kb.id
      setSelectedKbId(kb.id)
      setSelectedGroupId(null)
      setSelectedSourceViewId(null)
      setViewMode('kb')
      addRecentAccess(kb)

      // Set selectedKb immediately with available data to avoid flashing the empty state,
      // then fetch full KB data for fields omitted from grouped lists.
      setSelectedKb(kb)
      const selectedScope = scope
      getKnowledgeBase(kb.id)
        .then(fullKb => {
          if (
            scopeRef.current !== selectedScope ||
            latestSelectedKbIdRef.current !== kb.id ||
            detailVersion.current !== version
          )
            return
          setDetailRequest({ kbId: kb.id, status: 'ready' })
          setSelectedKb(prev => {
            if (scopeRef.current !== selectedScope || latestSelectedKbIdRef.current !== kb.id)
              return prev
            return fullKb
          })
        })
        .catch(error => {
          if (
            scopeRef.current !== selectedScope ||
            latestSelectedKbIdRef.current !== kb.id ||
            detailVersion.current !== version
          )
            return
          setDetailRequest({ kbId: kb.id, status: 'error' })
          if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
            latestSelectedKbIdRef.current = null
            setSelectedKb(null)
            setSelectedKbId(null)
          }
          console.error('Failed to fetch full knowledge base data:', error)
        })
    },
    [addRecentAccess, scope, detailRequest]
  )

  const syncConvertedKnowledgeBase = useCallback(
    (updatedKb: KnowledgeBase) => {
      if (scopeRef.current !== scope) return
      setAllGroupedData(prev => {
        if (!prev) return prev

        const updateList = (items: KnowledgeBaseWithGroupInfo[]) =>
          items.map(item => (item.id === updatedKb.id ? mergeKnowledgeBase(item, updatedKb) : item))

        return {
          ...prev,
          personal: {
            created_by_me: updateList(prev.personal.created_by_me),
            shared_with_me: updateList(prev.personal.shared_with_me),
          },
          groups: prev.groups.map(group => ({
            ...group,
            knowledge_bases: updateList(group.knowledge_bases),
          })),
          organization: {
            ...prev.organization,
            knowledge_bases: updateList(prev.organization.knowledge_bases),
          },
        }
      })

      setSelectedKb(prev => {
        if (!prev || prev.id !== updatedKb.id) return prev
        return {
          ...prev,
          ...updatedKb,
        }
      })

      setFavorites(prev => prev.map(kb => (kb.id === updatedKb.id ? { ...kb, ...updatedKb } : kb)))

      setRecentAccessItems(prev => {
        const next = prev.map(item =>
          item.kbId === updatedKb.id
            ? {
                ...item,
                kbName: updatedKb.name,
                kbType: documentViewOf(updatedKb.kb_type) ?? 'notebook',
                namespace: updatedKb.namespace,
              }
            : item
        )
        saveRecentAccess(recentKey, next)
        return next
      })
    },
    [recentKey, scope]
  )

  const syncKnowledgeBase = useCallback(
    (updatedKb: KnowledgeBase) => {
      syncConvertedKnowledgeBase(updatedKb)
    },
    [syncConvertedKnowledgeBase]
  )

  const selectGroup = useCallback((groupId: string) => {
    latestSelectedKbIdRef.current = null
    setSelectedGroupId(groupId)
    setSelectedKbId(null)
    setSelectedSourceViewId(null)
    setSelectedKb(null)
    setViewMode('group')
    setFilterGroupId(groupId.startsWith('group-') ? groupId : null)
  }, [])

  const selectAll = useCallback(() => {
    latestSelectedKbIdRef.current = null
    setSelectedGroupId(null)
    setSelectedKbId(null)
    setSelectedSourceViewId(null)
    setSelectedKb(null)
    setViewMode('all')
    setFilterGroupId(null)
  }, [])

  const selectGroups = useCallback(() => {
    latestSelectedKbIdRef.current = null
    setSelectedGroupId(null)
    setSelectedKbId(null)
    setSelectedSourceViewId(null)
    setSelectedKb(null)
    setViewMode('groups')
    setFilterGroupId(null)
  }, [])

  const selectSourceView = useCallback((sourceViewId: string) => {
    latestSelectedKbIdRef.current = null
    setSelectedGroupId(null)
    setSelectedKbId(null)
    setSelectedSourceViewId(sourceViewId)
    setSelectedKb(null)
    setViewMode('source')
    setFilterGroupId(null)
  }, [])

  const clearSelection = useCallback(() => {
    latestSelectedKbIdRef.current = null
    setSelectedKbId(null)
    setSelectedKb(null)
    setSelectedGroupId(null)
    setSelectedSourceViewId(null)
    setViewMode('all')
    setFilterGroupId(null)
  }, [])

  const removeInaccessibleKnowledgeBase = useCallback(
    (kbId: number) => {
      if (scopeRef.current !== scope) return
      requestRef.current++
      setIsLoading(false)
      if (latestSelectedKbIdRef.current === kbId) latestSelectedKbIdRef.current = null
      setSelectedKb(prev => (prev?.id === kbId ? null : prev))
      setSelectedKbId(prev => (prev === kbId ? null : prev))
      const retain = (items: KnowledgeBaseWithGroupInfo[]) => items.filter(item => item.id !== kbId)
      setAllGroupedData(prev =>
        prev
          ? {
              ...prev,
              personal: {
                created_by_me: retain(prev.personal.created_by_me),
                shared_with_me: retain(prev.personal.shared_with_me),
              },
              groups: prev.groups.map(group => ({
                ...group,
                knowledge_bases: retain(group.knowledge_bases),
              })),
              organization: {
                ...prev.organization,
                knowledge_bases: retain(prev.organization.knowledge_bases),
              },
            }
          : prev
      )
      setFavorites(prev => prev.filter(item => item.id !== kbId))
      setRecentAccessItems(prev => {
        const next = prev.filter(item => item.kbId !== kbId)
        saveRecentAccess(recentKey, next)
        return next
      })
    },
    [scope, recentKey]
  )

  // Refresh all data
  const refreshAll = useCallback(async () => {
    await loadInitialData()
  }, [loadInitialData])

  return {
    // Favorites
    favorites,
    isFavoritesLoading,
    addFavorite,
    removeFavorite,
    reorderFavorites,

    // Recent access
    recentItems,
    addRecentAccess,
    clearRecentAccess,

    // Groups
    groups,
    isGroupsLoading: isLoading,

    // Selection
    selectedKbId,
    selectedGroupId,
    selectedSourceViewId,
    selectedKb,
    detailRequest,
    retrySelectedKb: () => {
      const kb = allKnowledgeBases.find(item => item.id === detailRequest?.kbId)
      if (kb) selectKb(kb)
    },
    selectKb,
    syncKnowledgeBase,
    syncConvertedKnowledgeBase,
    selectGroup,
    selectGroups,
    selectSourceView,
    clearSelection,
    removeInaccessibleKnowledgeBase,

    // View mode
    viewMode,
    selectAll,
    filterGroupId,
    setFilterGroupId,

    // Raw KBs for navigation and ID lookups
    allKnowledgeBases,
    allKnowledgeBasesWithGroupInfo,
    visibleKnowledgeBases,

    // Get group info for a KB
    getKbGroupInfo,

    // Current user
    currentUser: user,

    // Summary from backend
    summary: hasLoaded ? visibleCounts.summary : undefined,

    scopeKey: scope,
    loadError,
    hasLoaded,
    listRevision,
    // Refresh
    refreshAll,
  }
}

export default useKnowledgeSidebar
