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
  /** Callback to prefill the input box with the query text (called immediately on mount) */
  onPrefillMessage?: (message: string) => void
}

/**
 * Monitors URL query parameters `q`, `teamId`, `teamName`, `teamNamespace`, and `autoSend` to automatically
 * initiate a new conversation when the chat page is opened via an
 * external link like `/chat?q=hello&teamName=myAgent&teamNamespace=default&autoSend=true`.
 *
 * Behavior:
 * - Only fires when `q` is present and non-empty, and no `taskId` exists.
 * - `q` content is always prefilled into the input box immediately on mount.
 * - Auto-send only happens when `autoSend=true` is present in the URL.
 * - Waits for WebSocket connection + teams loaded before sending.
 * - Clears `q`, `teamId`, `teamName`, `teamNamespace`, and `autoSend` from URL after sending (taskId is
 *   set by the normal send flow).
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
  onPrefillMessage,
}: QueryParamAutoSendProps) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { isConnected } = useSocket()

  // Guard: ensure we only process once per page load
  const processedRef = useRef(false)
  // Track if user manually interacted before auto-send fires
  const userInteractedRef = useRef(false)

  // Keep latest values in refs so setTimeout callbacks always read current state
  const isConnectedRef = useRef(isConnected)
  const isTeamsLoadingRef = useRef(isTeamsLoading)
  const teamsRef = useRef(teams)
  const selectedTeamRef = useRef(selectedTeam)
  const onTeamChangeRef = useRef(onTeamChange)
  const onSendMessageRef = useRef(onSendMessage)

  useEffect(() => {
    isConnectedRef.current = isConnected
  }, [isConnected])

  useEffect(() => {
    isTeamsLoadingRef.current = isTeamsLoading
  }, [isTeamsLoading])

  useEffect(() => {
    teamsRef.current = teams
  }, [teams])

  useEffect(() => {
    selectedTeamRef.current = selectedTeam
  }, [selectedTeam])

  useEffect(() => {
    onTeamChangeRef.current = onTeamChange
  }, [onTeamChange])

  useEffect(() => {
    onSendMessageRef.current = onSendMessage
  }, [onSendMessage])

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

  // Remove q, teamId, teamName, teamNamespace, and autoSend from URL without adding browser history entries
  const clearQueryParams = useCallback(() => {
    const url = new URL(window.location.href)
    url.searchParams.delete('q')
    url.searchParams.delete('teamId')
    url.searchParams.delete('teamName')
    url.searchParams.delete('teamNamespace')
    url.searchParams.delete('autosend')
    router.replace(url.pathname + url.search)
  }, [router])

  // Prefill input box immediately when q param is present (even before auto-send conditions are met)
  const prefillDoneRef = useRef(false)
  useEffect(() => {
    if (prefillDoneRef.current) return
    if (hasTaskId) return

    const query = searchParams.get('q')
    if (!query) return

    const decodedMessage = decodeURIComponent(query).trim()
    if (!decodedMessage) return

    prefillDoneRef.current = true
    onPrefillMessage?.(decodedMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, hasTaskId])

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

    // Only auto-send when autoSend=true is explicitly set in the URL
    // Support both camelCase (autoSend) and lowercase (autosend) parameter names
    const autoSendParam = searchParams.get('autoSend') ?? searchParams.get('autosend')
    if (autoSendParam?.toLowerCase() !== 'true') {
      // No auto-send requested - just prefill (already done above) and stop
      processedRef.current = true
      return
    }

    const teamIdParam = searchParams.get('teamId')
    const targetTeamId = teamIdParam ? Number(teamIdParam) : null

    // Support team lookup by name and namespace (user-friendly alternative to teamId)
    const teamNameParam = searchParams.get('teamName')
    const teamNamespaceParam = searchParams.get('teamNamespace') || 'default'

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

      // Read latest values from refs to avoid stale closure
      const connected = isConnectedRef.current
      const teamsLoading = isTeamsLoadingRef.current
      const currentTeams = teamsRef.current

      // Check WebSocket readiness
      if (!connected) {
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
      if (teamsLoading || currentTeams.length === 0) {
        if (elapsed > WS_READY_TIMEOUT) {
          clearQueryParams()
          return
        }
        setTimeout(tryExecute, POLL_INTERVAL)
        return
      }
      // Switch team if requested (by ID or by name+namespace)
      let targetTeam: Team | undefined

      if (targetTeamId) {
        // Lookup by ID (backward compatible)
        targetTeam = currentTeams.find(t => t.id === targetTeamId)
      } else if (teamNameParam) {
        // Lookup by name and namespace (user-friendly)
        targetTeam = currentTeams.find(
          t => t.name === teamNameParam && t.namespace === teamNamespaceParam
        )
      }

      if (targetTeam) {
        const currentSelectedTeam = selectedTeamRef.current
        if (currentSelectedTeam?.id !== targetTeam.id) {
          onTeamChangeRef.current(targetTeam)
          // Allow a tick for the team change to propagate
          setTimeout(() => {
            if (!cancelled && !userInteractedRef.current) {
              executeAutoSend(decodedMessage)
            }
          }, POLL_INTERVAL)
          return
        }
      }
      // Team not found or already selected - fall through to use current/default team

      executeAutoSend(decodedMessage)
    }

    const executeAutoSend = (message: string) => {
      if (cancelled || userInteractedRef.current) {
        clearQueryParams()
        return
      }
      // Clean URL params before sending; the send handler will set taskId
      clearQueryParams()
      onSendMessageRef.current(message).catch(() => {
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
