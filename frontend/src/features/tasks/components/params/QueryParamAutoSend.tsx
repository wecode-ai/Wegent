// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useSocket } from '@/contexts/SocketContext'
import type { Team } from '@/types/api'

/** Timeout (ms) for waiting WebSocket connection before giving up */
const WS_READY_TIMEOUT = 10_000

/** Polling interval (ms) for checking readiness conditions */
const POLL_INTERVAL = 200

interface QueryParamAutoSendProps {
  /** Available teams to select from */
  teams: Team[]
  /** Whether teams have finished loading */
  isTeamsLoading: boolean
  /** Currently selected team */
  selectedTeam: Team | null
  /** Callback to change the selected team */
  onTeamChange: (team: Team) => void
  /** Callback to send a message (same as manual send) */
  onSendMessage: (message: string) => Promise<void>
  /** Whether there is an existing task selected (taskId in URL) */
  hasTaskId: boolean
}

/**
 * Monitors URL query parameters `q` and `teamId` to automatically
 * initiate a new conversation when the chat page is opened via an
 * external link like `/chat?q=hello&teamId=123`.
 *
 * Behavior:
 * - Only fires when `q` is present and non-empty, and no `taskId` exists.
 * - Waits for WebSocket connection + teams loaded before sending.
 * - Clears `q` and `teamId` from URL after sending (taskId is set by the
 *   normal send flow).
 * - Uses a ref guard to guarantee the message is sent at most once, even
 *   under React StrictMode double-render.
 */
export default function QueryParamAutoSend({
  teams,
  isTeamsLoading,
  selectedTeam,
  onTeamChange,
  onSendMessage,
  hasTaskId,
}: QueryParamAutoSendProps) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { isConnected } = useSocket()

  // Guard: ensure we only process once per page load
  const processedRef = useRef(false)
  // Track if user manually interacted before auto-send fires
  const userInteractedRef = useRef(false)

  // Detect user interaction (typing / team switch) to cancel auto-send
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore modifier-only keys
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
      userInteractedRef.current = true
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Remove q and teamId from URL without adding browser history entries
  const clearQueryParams = useCallback(() => {
    const url = new URL(window.location.href)
    url.searchParams.delete('q')
    url.searchParams.delete('teamId')
    router.replace(url.pathname + url.search)
  }, [router])

  useEffect(() => {
    // Already processed or user interacted
    if (processedRef.current) return

    // taskId takes priority - ignore q when viewing an existing task
    if (hasTaskId) {
      processedRef.current = true
      return
    }

    const query = searchParams.get('q')
    if (!query) return

    const decodedMessage = decodeURIComponent(query).trim()
    if (!decodedMessage) return

    const teamIdParam = searchParams.get('teamId')
    const targetTeamId = teamIdParam ? Number(teamIdParam) : null

    // Mark processed immediately to prevent duplicate triggers
    processedRef.current = true

    // Wait for prerequisites then send
    let cancelled = false
    const startTime = Date.now()

    const tryExecute = () => {
      if (cancelled) return
      if (userInteractedRef.current) {
        // User interacted, cancel auto-send but still clean URL params
        clearQueryParams()
        return
      }

      const elapsed = Date.now() - startTime

      // Check WebSocket readiness
      if (!isConnected) {
        if (elapsed > WS_READY_TIMEOUT) {
          // Timeout - clean up params and give up
          clearQueryParams()
          return
        }
        // Retry after a short delay; polling is handled via setTimeout
        setTimeout(tryExecute, POLL_INTERVAL)
        return
      }

      // Check teams loaded
      if (isTeamsLoading || teams.length === 0) {
        if (elapsed > WS_READY_TIMEOUT) {
          clearQueryParams()
          return
        }
        setTimeout(tryExecute, POLL_INTERVAL)
        return
      }

      // Switch team if requested
      if (targetTeamId) {
        const targetTeam = teams.find(t => t.id === targetTeamId)
        if (targetTeam && selectedTeam?.id !== targetTeamId) {
          onTeamChange(targetTeam)
          // Allow a tick for the team change to propagate
          setTimeout(() => {
            if (!cancelled && !userInteractedRef.current) {
              executeAutoSend(decodedMessage)
            }
          }, POLL_INTERVAL)
          return
        }
        // targetTeamId not found - fall through to use current/default team
      }

      executeAutoSend(decodedMessage)
    }

    const executeAutoSend = (message: string) => {
      if (cancelled || userInteractedRef.current) {
        clearQueryParams()
        return
      }
      // Clean URL params before sending; the send handler will set taskId
      clearQueryParams()
      onSendMessage(message).catch(() => {
        // Error handling is done inside onSendMessage (toast etc.)
      })
    }

    // Start the readiness polling
    tryExecute()

    return () => {
      cancelled = true
    }
    // We intentionally use a minimal dependency array.
    // The ref guards and the cancelled flag prevent double execution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, hasTaskId])

  return null
}
