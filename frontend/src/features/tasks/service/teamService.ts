// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react'
import { teamApis } from '@/apis/team'
import type { Team } from '@/types/api'
import type { TeamListResponse } from '@/apis/team'
import { sortTeamsByUpdatedAt } from '@/utils/team'

/** Delays between automatic retries of the team list request, in milliseconds. */
export const TEAM_FETCH_RETRY_DELAYS_MS = [500, 1500]

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new DOMException('Aborted', 'AbortError'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })

const fetchTeams = async (signal?: AbortSignal, refresh = false): Promise<Team[]> => {
  const response = await teamApis.getAllTeams('all', undefined, refresh, { signal })
  const items = Array.isArray(response.items) ? response.items : []
  return sortTeamsByUpdatedAt(items)
}

export interface UseTeamsResult {
  teams: Team[]
  isTeamsLoading: boolean
  /** Error from the latest failed load, cleared on success. */
  loadError: Error | null
  refreshTeams: () => Promise<Team[]>
  addTeam: (team: Team) => void
}

/**
 * Service for team related business logic
 */
export const teamService = {
  /**
   * Get team list
   */
  async getTeams(): Promise<TeamListResponse> {
    return teamApis.getAllTeams('all')
  },

  /**
   * Fetch the accessible team list, retrying transient failures with backoff.
   * A single failed request must never surface as "no agents available".
   */
  async fetchTeamsWithRetry(signal?: AbortSignal, refresh = false): Promise<Team[]> {
    let lastError: unknown

    for (let attempt = 0; attempt <= TEAM_FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await fetchTeams(signal, refresh)
      } catch (error) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }

        lastError = error
        const retryDelay = TEAM_FETCH_RETRY_DELAYS_MS[attempt]
        if (retryDelay === undefined) {
          break
        }

        await sleep(retryDelay, signal)
      }
    }

    throw lastError
  },

  /**
   * React hook: Get team related status
   */
  useTeams(): UseTeamsResult {
    const [teams, setTeams] = useState<Team[]>([])
    const [isTeamsLoading, setIsTeamsLoading] = useState(true)
    const [loadError, setLoadError] = useState<Error | null>(null)
    const retryAbortRef = useRef<AbortController | null>(null)

    const refreshTeams = useCallback(async (): Promise<Team[]> => {
      setIsTeamsLoading(true)

      retryAbortRef.current?.abort()
      const abortController = new AbortController()
      retryAbortRef.current = abortController

      try {
        const sortedTeams = await teamService.fetchTeamsWithRetry(abortController.signal)

        // Ignore completions from an aborted refresh so a newer request wins.
        if (abortController.signal.aborted || retryAbortRef.current !== abortController) {
          return []
        }

        setTeams(sortedTeams)
        setLoadError(null)
        return sortedTeams
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error
        }

        if (abortController.signal.aborted || retryAbortRef.current !== abortController) {
          return []
        }

        console.error('[teamService] Failed to fetch teams:', error)
        // Keep the previously loaded teams so a transient failure does not
        // replace a usable list with the "no agents" empty state.
        setLoadError(error instanceof Error ? error : new Error(String(error)))
        throw error
      } finally {
        if (retryAbortRef.current === abortController) {
          retryAbortRef.current = null
          setIsTeamsLoading(false)
        }
      }
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

    useEffect(() => {
      void refreshTeams().catch(() => {
        // Failure is surfaced through loadError.
      })

      return () => {
        retryAbortRef.current?.abort()
      }
    }, [refreshTeams])

    return {
      teams,
      isTeamsLoading,
      loadError,
      refreshTeams,
      addTeam,
    }
  },
}
