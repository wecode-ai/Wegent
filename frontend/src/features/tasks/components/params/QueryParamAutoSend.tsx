// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useSocket } from '@/contexts/SocketContext'
import type { Team } from '@/types/api'

/** Timeout (ms) for waiting for auto-send prerequisites before giving up */
const WS_READY_TIMEOUT = 10_000

/** Polling interval (ms) for checking readiness conditions */
const POLL_INTERVAL = 200

type QueryAction = {
  key: string
  prefilled: boolean
  handled: boolean
  interacted: boolean
  awaitingTaskNavigation: boolean
}

function autoSendRequested(params: Pick<URLSearchParams, 'get'>) {
  return (params.get('autoSend') ?? params.get('autosend'))?.toLowerCase() === 'true'
}

function getQueryActionKey(params: Pick<URLSearchParams, 'get'>) {
  const message = params.get('q')?.trim()
  if (!message) return null
  return JSON.stringify([
    message,
    params.get('teamId'),
    params.get('teamName'),
    params.get('teamNamespace') || 'default',
    params.get('projectId') || null,
    params.get('conversationGroupId') || null,
    params.get('deviceId') || params.get('device_id'),
    params.get('agent'),
    params.get('mode'),
    autoSendRequested(params),
  ])
}

interface QueryParamAutoSendProps {
  /** Available teams to select from */
  teams: Team[]
  /** Whether teams have finished loading */
  isTeamsLoading: boolean
  /** Whether the final initial team selection has committed */
  isTeamSelectionReady: boolean
  /** Currently selected team */
  selectedTeam: Team | null
  /** Callback to change the selected team */
  onTeamChange: (team: Team) => void
  /** Callback to send a message (same as manual send) */
  onSendMessage: (message: string, onFailure: () => void) => Promise<void>
  /** Whether there is an existing task selected (taskId in URL) */
  hasTaskId: boolean
  /** Callback to prefill the input box when a new query prompt arrives */
  onPrefillMessage?: (message: string) => void
}

/**
 * Monitors URL query parameters `q`, `teamId`, `teamName`, `teamNamespace`, and `autoSend` to automatically
 * initiate a new conversation when the chat page is opened via an
 * external link like `/chat?q=hello&teamName=myAgent&teamNamespace=default&autoSend=true`.
 *
 * Behavior:
 * - Only fires when `q` is present and non-empty, and no `taskId` exists.
 * - Each new `q` prompt prefills the input immediately.
 * - Auto-send only happens when `autoSend=true` is present in the URL.
 * - Waits for WebSocket connection, teams loaded, and final team selection before sending.
 * - Clears `q`, `teamId`, `teamName`, `teamNamespace`, and `autoSend` after the normal send flow
 *   commits taskId to the URL.
 * - Uses a ref guard to guarantee the message is sent at most once, even
 *   under React StrictMode double-render.
 */
export default function QueryParamAutoSend({
  teams,
  isTeamsLoading,
  isTeamSelectionReady,
  selectedTeam,
  onTeamChange,
  onSendMessage,
  hasTaskId,
  onPrefillMessage,
}: QueryParamAutoSendProps) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { isConnected } = useSocket()

  const actionKey = getQueryActionKey(searchParams)
  const actionRef = useRef<QueryAction | null>(null)
  const completedAutoSendKeys = useRef(new Set<string>())

  // Keep latest values in refs so setTimeout callbacks always read current state
  const isConnectedRef = useRef(isConnected)
  const isTeamsLoadingRef = useRef(isTeamsLoading)
  const isTeamSelectionReadyRef = useRef(isTeamSelectionReady)
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
    isTeamSelectionReadyRef.current = isTeamSelectionReady
  }, [isTeamSelectionReady])

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

  // A keypress cancels auto-send for the current prompt only.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore modifier-only keys
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
      if (actionRef.current) actionRef.current.interacted = true
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Remove consumed action parameters without adding a browser history entry.
  const clearQueryParams = useCallback(
    (key: string, keepTeamId = false) => {
      const url = new URL(window.location.href)
      if (getQueryActionKey(url.searchParams) !== key) return
      url.searchParams.delete('q')
      if (!keepTeamId) {
        url.searchParams.delete('teamId')
        url.searchParams.delete('recommend')
        url.searchParams.delete('conversationGroupId')
      }
      url.searchParams.delete('teamName')
      url.searchParams.delete('teamNamespace')
      url.searchParams.delete('autoSend')
      url.searchParams.delete('autosend')
      router.replace(url.pathname + url.search + url.hash)
    },
    [router]
  )

  useEffect(() => {
    if (actionKey === null) {
      actionRef.current = null
      return
    }
    const existing = actionRef.current
    const action =
      existing?.key === actionKey
        ? existing
        : {
            key: actionKey,
            prefilled: false,
            handled: false,
            interacted: false,
            awaitingTaskNavigation: false,
          }
    actionRef.current = action

    // Successful sends carry the action parameters into their new task URL.
    if (hasTaskId) {
      if (action.awaitingTaskNavigation) {
        action.awaitingTaskNavigation = false
        clearQueryParams(action.key)
      }
      action.handled = true
      return
    }
    if (action.handled || completedAutoSendKeys.current.has(action.key)) return

    const message = searchParams.get('q')?.trim()
    if (!message) return
    if (!action.prefilled) {
      action.prefilled = true
      onPrefillMessage?.(message)
    }
    action.handled = true
    if (!autoSendRequested(searchParams)) return

    const teamIdParam = searchParams.get('teamId')
    const parsedTeamId = teamIdParam === null ? null : Number(teamIdParam)
    const targetTeamId =
      parsedTeamId !== null && Number.isSafeInteger(parsedTeamId) && parsedTeamId > 0
        ? parsedTeamId
        : null

    // Support team lookup by name and namespace (user-friendly alternative to teamId)
    const teamNameParam = searchParams.get('teamName')
    const teamNamespaceParam = searchParams.get('teamNamespace') || 'default'

    if (teamIdParam !== null && targetTeamId === null && !teamNameParam) {
      clearQueryParams(action.key, true)
      return
    }

    // Wait for prerequisites then send
    let cancelled = false
    let completed = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let requestedTeamId: number | null = null
    const startTime = Date.now()

    const finishWithoutSending = () => {
      completed = true
      completedAutoSendKeys.current.add(action.key)
      clearQueryParams(action.key, true)
    }

    const waitForReadiness = () => {
      if (Date.now() - startTime > WS_READY_TIMEOUT) {
        finishWithoutSending()
        return
      }
      timeoutId = setTimeout(tryExecute, POLL_INTERVAL)
    }

    const tryExecute = () => {
      if (cancelled) return
      if (action.interacted) {
        // User interacted, cancel auto-send but still clean URL params
        finishWithoutSending()
        return
      }

      // Read latest values from refs to avoid stale closure
      const connected = isConnectedRef.current
      const teamsLoading = isTeamsLoadingRef.current
      const currentTeams = teamsRef.current

      if (!connected) {
        waitForReadiness()
        return
      }

      const currentSelectedTeam = selectedTeamRef.current
      // ChatArea resolves explicit IDs independently of the catalog.
      if (targetTeamId !== null) {
        if (isTeamSelectionReadyRef.current && currentSelectedTeam?.id === targetTeamId) {
          executeAutoSend(message)
        } else {
          waitForReadiness()
        }
        return
      }

      if (teamsLoading || currentTeams.length === 0) {
        waitForReadiness()
        return
      }
      const targetTeam = teamNameParam
        ? currentTeams.find(t => t.name === teamNameParam && t.namespace === teamNamespaceParam)
        : undefined
      if (teamNameParam && !targetTeam) {
        waitForReadiness()
        return
      }
      if (
        targetTeam &&
        (currentSelectedTeam?.id !== targetTeam.id ||
          (teamIdParam !== null && !isTeamSelectionReadyRef.current))
      ) {
        if (requestedTeamId !== targetTeam.id) {
          requestedTeamId = targetTeam.id
          onTeamChangeRef.current(targetTeam)
        }
        waitForReadiness()
        return
      }

      if (!isTeamSelectionReadyRef.current || !currentSelectedTeam) {
        waitForReadiness()
        return
      }
      executeAutoSend(message)
    }

    const executeAutoSend = (message: string) => {
      if (cancelled || action.interacted) {
        finishWithoutSending()
        return
      }
      completed = true
      // Task creation pushes a history entry, leaving the original link behind it.
      completedAutoSendKeys.current.add(action.key)
      action.awaitingTaskNavigation = true
      const onFailure = () => {
        if (cancelled || actionRef.current !== action || !action.awaitingTaskNavigation) return
        action.awaitingTaskNavigation = false
        clearQueryParams(action.key, true)
      }
      void onSendMessageRef.current(message, onFailure).catch(onFailure)
    }

    // Start the readiness polling
    tryExecute()

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
      if (!completed) action.handled = false
    }
    // We intentionally use a minimal dependency array.
    // The ref guards and the cancelled flag prevent double execution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionKey, hasTaskId])

  return null
}
