// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Team Context Provider
 *
 * Shares a full catalog between active selectors. Management views use the
 * paginated resource API; consumers that only invalidate data disable loading.
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  ReactNode,
} from 'react'
import { teamService } from '@/features/tasks/service/teamService'
import type { Team } from '@/types/api'
import { sortTeamsByUpdatedAt } from '@/utils/team'
import { useUser } from '@/features/common/UserContext'

interface TeamContextType {
  /** List of teams */
  teams: Team[]
  /** Whether teams are currently loading */
  isTeamsLoading: boolean
  /** Error from the latest failed load, cleared on success. */
  loadError: Error | null
  /** Refresh teams from API */
  refreshTeams: () => Promise<Team[]>
  /** Add a new team to the list (optimistic update) */
  addTeam: (team: Team) => void
  invalidateTeams: () => void
}

const TeamContext = createContext<
  (TeamContextType & { ensureTeams: () => Promise<void> }) | undefined
>(undefined)

export function TeamProvider({ children }: { children: ReactNode }) {
  const { user } = useUser()
  const userId = user?.id
  const [teams, setTeams] = useState<Team[]>([])
  const [isTeamsLoading, setIsTeamsLoading] = useState(true)
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const key = `${userId}:${revision}`
  const sequence = useRef(0)
  const pending = useRef<{
    userId: number
    id: number
    controller: AbortController
    request: Promise<Team[]>
  } | null>(null)

  const refreshTeams = useCallback(async (): Promise<Team[]> => {
    if (userId === undefined) return []
    if (pending.current?.userId === userId) return pending.current.request
    pending.current?.controller.abort()
    const controller = new AbortController()
    setIsTeamsLoading(true)
    const id = ++sequence.current
    const request: Promise<Team[]> = (async () => {
      try {
        const sortedTeams = await teamService.fetchTeamsWithRetry(controller.signal, true)
        if (pending.current?.id === id) {
          setTeams(sortedTeams)
          setLoadError(null)
          setLoadedKey(key)
        }
        return sortedTeams
      } catch (error) {
        if (controller.signal.aborted) throw error
        console.error('[TeamContext] Failed to fetch teams:', error)
        if (pending.current?.id === id) {
          setLoadError(error instanceof Error ? error : new Error(String(error)))
        }
        throw error
      } finally {
        if (pending.current?.id === id) {
          pending.current = null
          setIsTeamsLoading(false)
        }
      }
    })()
    pending.current = { userId, id, controller, request }
    return request
  }, [userId, key])

  useEffect(() => {
    return () => {
      pending.current?.controller.abort()
      pending.current = null
    }
  }, [userId])

  const ensureTeams = useCallback(async () => {
    if (userId !== undefined && loadedKey !== key) await refreshTeams()
  }, [loadedKey, key, userId, refreshTeams])
  const invalidateTeams = useCallback(() => {
    pending.current?.controller.abort()
    pending.current = null
    setLoadedKey(null)
    setRevision(value => value + 1)
  }, [])

  const addTeam = useCallback((newTeam: Team) => {
    setTeams(prevTeams => {
      // Check if team already exists
      const exists = prevTeams.some(team => team.id === newTeam.id)
      if (exists) {
        return prevTeams
      }
      // Add new team and re-sort
      const updatedTeams = [...prevTeams, newTeam]
      return sortTeamsByUpdatedAt(updatedTeams)
    })
  }, [])

  return (
    <TeamContext.Provider
      value={{
        teams: loadedKey === key ? teams : [],
        isTeamsLoading,
        loadError,
        refreshTeams,
        addTeam,
        ensureTeams,
        invalidateTeams,
      }}
    >
      {children}
    </TeamContext.Provider>
  )
}

/**
 * Hook to access team context
 *
 * @throws Error if used outside of TeamProvider
 */
export function useTeamContext({ enabled = true }: { enabled?: boolean } = {}): TeamContextType {
  const context = useContext(TeamContext)
  const ensureTeams = context?.ensureTeams
  useEffect(() => {
    if (enabled) void ensureTeams?.().catch(() => {})
  }, [enabled, ensureTeams])
  if (!context) {
    throw new Error('useTeamContext must be used within a TeamProvider')
  }
  return context
}
