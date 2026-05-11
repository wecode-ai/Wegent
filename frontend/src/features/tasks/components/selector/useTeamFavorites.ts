// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { userApis } from '@/apis/user'
import { useUser } from '@/features/common/UserContext'
import type { QuickAccessConfig, Team, UserPreferences } from '@/types/api'

interface UseTeamFavoritesOptions {
  initialFavoriteTeamIds?: number[]
  initialSystemRecommendedTeamIds?: number[]
  loadMetadata?: boolean
}

function addFavoriteBeforeSystemRecommendations(
  teamIds: number[],
  teamId: number,
  systemRecommendedTeamIds: Set<number>
) {
  const userFavoriteIds = teamIds.filter(id => !systemRecommendedTeamIds.has(id))
  const systemIds = teamIds.filter(id => systemRecommendedTeamIds.has(id))
  return [...userFavoriteIds, teamId, ...systemIds]
}

export function useTeamFavorites({
  initialFavoriteTeamIds,
  initialSystemRecommendedTeamIds,
  loadMetadata = true,
}: UseTeamFavoritesOptions = {}) {
  const { user, refresh } = useUser()
  const [favoriteUpdatingTeamId, setFavoriteUpdatingTeamId] = useState<number | null>(null)
  const [localFavoriteTeamIds, setLocalFavoriteTeamIds] = useState<number[] | null>(
    initialFavoriteTeamIds ?? null
  )
  const [systemRecommendedTeamIds, setSystemRecommendedTeamIds] = useState<number[]>(
    initialSystemRecommendedTeamIds ?? []
  )
  const [quickAccessMetaLoaded, setQuickAccessMetaLoaded] = useState(
    !loadMetadata || Boolean(initialSystemRecommendedTeamIds)
  )

  const initialFavoriteKey = initialFavoriteTeamIds?.join(',') ?? ''
  const initialSystemRecommendedKey = initialSystemRecommendedTeamIds?.join(',') ?? ''

  useEffect(() => {
    if (initialFavoriteTeamIds) {
      setLocalFavoriteTeamIds(initialFavoriteTeamIds)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFavoriteKey])

  useEffect(() => {
    if (initialSystemRecommendedTeamIds) {
      setSystemRecommendedTeamIds(initialSystemRecommendedTeamIds)
      setQuickAccessMetaLoaded(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSystemRecommendedKey])

  useEffect(() => {
    if (!loadMetadata) return

    let isMounted = true

    const loadQuickAccessMeta = async () => {
      try {
        const quickAccess = await userApis.getQuickAccess()
        if (isMounted) {
          setSystemRecommendedTeamIds(quickAccess.system_team_ids ?? [])
        }
      } catch (error) {
        console.error('Failed to load quick access metadata:', error)
        if (isMounted) {
          setSystemRecommendedTeamIds([])
        }
      } finally {
        if (isMounted) {
          setQuickAccessMetaLoaded(true)
        }
      }
    }

    loadQuickAccessMeta()

    return () => {
      isMounted = false
    }
  }, [loadMetadata])

  const quickAccessConfig = user?.preferences?.quick_access
  const favoriteTeamIds = useMemo(
    () => localFavoriteTeamIds ?? quickAccessConfig?.teams ?? initialFavoriteTeamIds ?? [],
    [initialFavoriteTeamIds, localFavoriteTeamIds, quickAccessConfig?.teams]
  )
  const favoriteTeamIdSet = useMemo(() => new Set(favoriteTeamIds), [favoriteTeamIds])
  const systemRecommendedTeamIdSet = useMemo(
    () => new Set(systemRecommendedTeamIds),
    [systemRecommendedTeamIds]
  )

  const handleToggleFavorite = useCallback(
    async (event: React.MouseEvent, team: Team) => {
      event.preventDefault()
      event.stopPropagation()

      try {
        setFavoriteUpdatingTeamId(team.id)
        const currentUser = user ?? (await userApis.getCurrentUser())
        const currentPreferences: UserPreferences = {
          send_key: currentUser.preferences?.send_key || 'enter',
          ...currentUser.preferences,
        }
        const currentQuickAccess: QuickAccessConfig = currentPreferences.quick_access ?? {
          teams: [],
        }
        const currentTeamIds = localFavoriteTeamIds ?? currentQuickAccess.teams
        if (systemRecommendedTeamIdSet.has(team.id)) {
          return
        }
        const isFavorite = currentTeamIds.includes(team.id)
        const nextTeamIds = isFavorite
          ? currentTeamIds.filter(teamId => teamId !== team.id)
          : addFavoriteBeforeSystemRecommendations(
              currentTeamIds,
              team.id,
              systemRecommendedTeamIdSet
            )

        const nextQuickAccess = {
          ...(currentQuickAccess.version !== undefined
            ? { version: currentQuickAccess.version }
            : {}),
          teams: nextTeamIds,
        }

        await userApis.updateUser({
          preferences: {
            ...currentPreferences,
            quick_access: nextQuickAccess,
          },
        })
        setLocalFavoriteTeamIds(nextTeamIds)
        await refresh()
        window.dispatchEvent(new Event('quick-access-updated'))
      } finally {
        setFavoriteUpdatingTeamId(null)
      }
    },
    [localFavoriteTeamIds, refresh, systemRecommendedTeamIdSet, user]
  )

  return {
    favoriteTeamIds,
    favoriteTeamIdSet,
    favoriteUpdatingTeamId,
    handleToggleFavorite,
    quickAccessMetaLoaded,
    systemRecommendedTeamIds,
    systemRecommendedTeamIdSet,
  }
}
