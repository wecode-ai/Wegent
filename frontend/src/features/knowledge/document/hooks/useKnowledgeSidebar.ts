// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useKnowledgeSidebar - Hook for managing knowledge sidebar state.
 *
 * Combines favorites, recent access, and groups data for the sidebar.
 * Uses the optimized all-grouped API to solve N+1 query problem.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { getKnowledgeBase } from '@/apis/knowledge'
import { useUser } from '@/features/common/UserContext'
import type {
  KnowledgeBase,
  AllGroupedKnowledgeResponse,
  KnowledgeBaseWithGroupInfo,
  KnowledgeGroupType,
} from '@/types/knowledge'
import type { KbDataItem } from '../components/KnowledgeGroupListPage'
import type { Group } from '@/types/group'
import type { User } from '@/types/api'

// Storage keys
const RECENT_STORAGE_KEY = 'knowledge-recent-access'
const MAX_RECENT_ITEMS = 5

export type GroupType = 'personal' | 'group' | 'organization'

/** View mode for the knowledge page */
export type ViewMode = 'all' | 'group' | 'kb' | 'groups'

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

/** Group info for a knowledge base */
export interface KbGroupInfo {
  groupId: string
  groupName: string
  groupType: KnowledgeGroupType
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
  selectedKb: KnowledgeBase | null
  selectKb: (kb: KnowledgeBase) => void
  selectGroup: (groupId: string) => void
  selectGroups: () => void
  clearSelection: () => void

  // View mode
  viewMode: ViewMode
  selectAll: () => void
  filterGroupId: string | null
  setFilterGroupId: (groupId: string | null) => void

  // All KBs for search and display
  allKnowledgeBases: KnowledgeBase[]
  allKnowledgeBasesWithGroupInfo: KnowledgeBaseWithGroupInfo[]

  // Personal KBs grouped by ownership (for "Personal" group display)
  personalCreatedByMe: KnowledgeBaseWithGroupInfo[]
  personalSharedWithMe: KnowledgeBaseWithGroupInfo[]

  // Get group info for a KB (accepts both KnowledgeBase and KnowledgeBaseWithGroupInfo)
  getKbGroupInfo: (kb: KbDataItem) => KbGroupInfo

  // Current user
  currentUser: User | null

  // Refresh
  refreshAll: () => Promise<void>
}

/**
 * Load recent access from localStorage
 */
function loadRecentAccess(): RecentAccessItem[] {
  try {
    const saved = localStorage.getItem(RECENT_STORAGE_KEY)
    return saved ? JSON.parse(saved) : []
  } catch {
    return []
  }
}

/**
 * Save recent access to localStorage
 */
function saveRecentAccess(items: RecentAccessItem[]) {
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(items))
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

export function useKnowledgeSidebar(): UseKnowledgeSidebarReturn {
  const { user } = useUser()

  // Data state - using the new all-grouped API response
  const [allGroupedData, setAllGroupedData] = useState<AllGroupedKnowledgeResponse | null>(null)

  // Loading state
  const [isLoading, setIsLoading] = useState(true)
  const [isFavoritesLoading, setIsFavoritesLoading] = useState(false)

  // Favorites state (will be loaded from API when backend is ready)
  const [favorites, setFavorites] = useState<KnowledgeBase[]>([])

  // Recent access state
  const [recentAccessItems, setRecentAccessItems] = useState<RecentAccessItem[]>(loadRecentAccess)

  // Selection state
  const [selectedKbId, setSelectedKbId] = useState<number | null>(null)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [selectedKb, setSelectedKb] = useState<KnowledgeBase | null>(null)

  // View mode state
  const [viewMode, setViewMode] = useState<ViewMode>('all')
  const [filterGroupId, setFilterGroupId] = useState<string | null>(null)

  // Load initial data using the optimized all-grouped API
  const loadInitialData = useCallback(async () => {
    setIsLoading(true)
    try {
      const response = await knowledgeBaseApi.getAllGrouped()
      setAllGroupedData(response)
    } catch (error) {
      console.error('Failed to load knowledge sidebar data:', error)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (user) {
      loadInitialData()
    }
  }, [user, loadInitialData])

  // Build all knowledge bases with group info list
  const allKnowledgeBasesWithGroupInfo = useMemo((): KnowledgeBaseWithGroupInfo[] => {
    if (!allGroupedData) return []

    const all: KnowledgeBaseWithGroupInfo[] = [
      ...allGroupedData.personal.created_by_me,
      ...allGroupedData.personal.shared_with_me,
      ...allGroupedData.groups.flatMap(g => g.knowledge_bases),
      ...allGroupedData.organization.knowledge_bases,
    ]

    // Remove duplicates by ID
    const seen = new Set<number>()
    return all.filter(kb => {
      if (seen.has(kb.id)) return false
      seen.add(kb.id)
      return true
    })
  }, [allGroupedData])

  // Build all knowledge bases list for search (without group info)
  const allKnowledgeBases = useMemo((): KnowledgeBase[] => {
    return allKnowledgeBasesWithGroupInfo.map(toKnowledgeBase)
  }, [allKnowledgeBasesWithGroupInfo])

  // Build a map from KB ID to group info for quick lookup
  const kbGroupInfoMap = useMemo((): Map<number, KbGroupInfo> => {
    const map = new Map<number, KbGroupInfo>()
    allKnowledgeBasesWithGroupInfo.forEach(kb => {
      map.set(kb.id, {
        groupId: kb.group_id,
        groupName: kb.group_name,
        groupType: kb.group_type,
      })
    })
    return map
  }, [allKnowledgeBasesWithGroupInfo])

  // Get group info for a KB (accepts both KnowledgeBase and KnowledgeBaseWithGroupInfo)
  const getKbGroupInfo = useCallback(
    (kb: KbDataItem): KbGroupInfo => {
      // If kb already has group info (KnowledgeBaseWithGroupInfo), use it directly
      if ('group_id' in kb && 'group_name' in kb && 'group_type' in kb) {
        return {
          groupId: kb.group_id,
          groupName: kb.group_name,
          groupType: kb.group_type,
        }
      }

      // Otherwise, look up from the map
      const info = kbGroupInfoMap.get(kb.id)
      if (info) return info

      // Fallback: determine group info from namespace
      if (kb.namespace === 'default') {
        return {
          groupId: 'default',
          groupName: '个人',
          groupType: 'personal',
        }
      }
      return {
        groupId: kb.namespace,
        groupName: kb.namespace,
        groupType: 'group',
      }
    },
    [kbGroupInfoMap]
  )

  // Build groups list with KB counts
  const groups = useMemo((): KnowledgeGroup[] => {
    if (!allGroupedData) return []

    const result: KnowledgeGroup[] = []

    // Personal group
    const personalKbCount =
      allGroupedData.personal.created_by_me.length + allGroupedData.personal.shared_with_me.length
    result.push({
      id: 'personal',
      type: 'personal',
      name: 'personal',
      displayName: '个人',
      kbCount: personalKbCount,
    })

    // Team groups
    allGroupedData.groups.forEach(group => {
      result.push({
        id: `group-${group.group_name}`,
        type: 'group',
        name: group.group_name,
        displayName: group.group_display_name || group.group_name,
        kbCount: group.kb_count,
      })
    })

    // Organization group
    result.push({
      id: 'organization',
      type: 'organization',
      name: allGroupedData.organization.namespace || 'organization',
      displayName: allGroupedData.organization.display_name || '公司',
      kbCount: allGroupedData.organization.kb_count,
    })

    return result
  }, [allGroupedData])

  // Convert recent access items to KnowledgeBase objects
  const recentItems = useMemo(() => {
    return recentAccessItems
      .map(item => allKnowledgeBases.find(kb => kb.id === item.kbId))
      .filter((kb): kb is KnowledgeBase => kb !== undefined)
      .slice(0, MAX_RECENT_ITEMS)
  }, [recentAccessItems, allKnowledgeBases])

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
  const addRecentAccess = useCallback((kb: KnowledgeBase) => {
    setRecentAccessItems(prev => {
      const filtered = prev.filter(item => item.kbId !== kb.id)
      const newItem: RecentAccessItem = {
        kbId: kb.id,
        kbName: kb.name,
        kbType: (kb.kb_type as 'notebook' | 'classic') || 'notebook',
        namespace: kb.namespace,
        accessedAt: Date.now(),
      }
      const updated = [newItem, ...filtered].slice(0, MAX_RECENT_ITEMS)
      saveRecentAccess(updated)
      return updated
    })
  }, [])

  const clearRecentAccess = useCallback(() => {
    setRecentAccessItems([])
    saveRecentAccess([])
  }, [])

  // Selection management
  const selectKb = useCallback(
    (kb: KnowledgeBase) => {
      setSelectedKbId(kb.id)
      setSelectedKb(kb)
      setSelectedGroupId(null)
      setViewMode('kb')
      addRecentAccess(kb)

      // For notebook type, fetch full KB data to get guided_questions
      if (kb.kb_type === 'notebook') {
        getKnowledgeBase(kb.id)
          .then(fullKb => {
            // Only update if still selected (avoid race condition)
            setSelectedKb(prev => (prev?.id === kb.id ? fullKb : prev))
          })
          .catch(error => {
            console.error('Failed to fetch full knowledge base data:', error)
          })
      }
    },
    [addRecentAccess]
  )

  const selectGroup = useCallback((groupId: string) => {
    setSelectedGroupId(groupId)
    setSelectedKbId(null)
    setSelectedKb(null)
    setViewMode('group')
    setFilterGroupId(groupId)
  }, [])

  const selectAll = useCallback(() => {
    setSelectedGroupId(null)
    setSelectedKbId(null)
    setSelectedKb(null)
    setViewMode('all')
    setFilterGroupId(null)
  }, [])

  const selectGroups = useCallback(() => {
    setSelectedGroupId(null)
    setSelectedKbId(null)
    setSelectedKb(null)
    setViewMode('groups')
    setFilterGroupId(null)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedKbId(null)
    setSelectedKb(null)
    setSelectedGroupId(null)
    setViewMode('all')
    setFilterGroupId(null)
  }, [])

  // Refresh all data
  const refreshAll = useCallback(async () => {
    await loadInitialData()
  }, [loadInitialData])

  // Personal KBs grouped by ownership
  const personalCreatedByMe = useMemo((): KnowledgeBaseWithGroupInfo[] => {
    return allGroupedData?.personal.created_by_me || []
  }, [allGroupedData])

  const personalSharedWithMe = useMemo((): KnowledgeBaseWithGroupInfo[] => {
    return allGroupedData?.personal.shared_with_me || []
  }, [allGroupedData])

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
    selectedKb,
    selectKb,
    selectGroup,
    selectGroups,
    clearSelection,

    // View mode
    viewMode,
    selectAll,
    filterGroupId,
    setFilterGroupId,

    // All KBs for search and display
    allKnowledgeBases,
    allKnowledgeBasesWithGroupInfo,

    // Personal KBs grouped by ownership
    personalCreatedByMe,
    personalSharedWithMe,

    // Get group info for a KB
    getKbGroupInfo,

    // Current user
    currentUser: user,

    // Refresh
    refreshAll,
  }
}

export default useKnowledgeSidebar
