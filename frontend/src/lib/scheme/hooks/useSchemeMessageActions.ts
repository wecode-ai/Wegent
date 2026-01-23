// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from 'react'

/**
 * Configuration for scheme message actions
 */
export interface SchemeMessageActionsConfig {
  /** Callback to send a message */
  onSendMessage: (text: string) => void
  /** Callback to prefill message input */
  onPrefillMessage: (text: string) => void
  /** Callback to change team (optional) */
  onTeamChange?: (teamId: number) => void
  /** Current team ID (required if onTeamChange is provided) */
  currentTeamId?: number
  /** List of available teams with IDs (required if onTeamChange is provided) */
  teams?: Array<{ id: number }>
}

/**
 * Custom hook to handle scheme URL message actions.
 *
 * This hook listens to `wegent:send-message` and `wegent:prefill-message` DOM events
 * dispatched by the scheme system and executes the corresponding callbacks.
 *
 * It also handles team switching if a team parameter is provided in the scheme URL.
 *
 * @param config Configuration object with callbacks and team data
 *
 * @example
 * ```tsx
 * useSchemeMessageActions({
 *   onSendMessage: streamHandlers.handleSendMessage,
 *   onPrefillMessage: chatState.setTaskInputMessage,
 *   onTeamChange: (teamId) => {
 *     const team = teams.find(t => t.id === teamId)
 *     if (team) handleTeamChange(team)
 *   },
 *   currentTeamId: chatState.selectedTeam?.id,
 *   teams: filteredTeams,
 * })
 * ```
 */
export function useSchemeMessageActions(config: SchemeMessageActionsConfig): void {
  const { onSendMessage, onPrefillMessage, onTeamChange, currentTeamId, teams } = config

  /**
   * Ref to store pending actions that need to be executed after team switching
   */
  const pendingActionRef = useRef<{
    type: 'send' | 'prefill'
    text: string
    teamId?: number
  } | null>(null)

  // Event listeners for scheme actions
  useEffect(() => {
    const dispatchAction = (action: {
      type: 'send' | 'prefill'
      text: string
      teamId?: number
    }) => {
      const { teamId, type, text } = action

      // If a team is specified and different from current, switch team first
      if (teamId && currentTeamId !== teamId && onTeamChange && teams) {
        const targetTeam = teams.find(t => t.id === teamId)

        if (targetTeam) {
          // Store action to execute after team switch
          pendingActionRef.current = action
          onTeamChange(teamId)
          return
        }
      }

      // Execute action immediately
      if (type === 'prefill') {
        onPrefillMessage(text)
      } else {
        onSendMessage(text)
      }
    }

    const onPrefill = (e: Event) => {
      const detail = (e as CustomEvent).detail as { text?: string; team?: string } | undefined
      const text = detail?.text?.trim()
      if (!text) return

      const teamId = detail?.team ? Number(detail.team) : undefined
      dispatchAction({ type: 'prefill', text, teamId })
    }

    const onSend = (e: Event) => {
      const detail = (e as CustomEvent).detail as { text?: string; team?: string } | undefined
      const text = detail?.text?.trim()
      if (!text) return

      const teamId = detail?.team ? Number(detail.team) : undefined
      dispatchAction({ type: 'send', text, teamId })
    }

    window.addEventListener('wegent:prefill-message', onPrefill)
    window.addEventListener('wegent:send-message', onSend)

    return () => {
      window.removeEventListener('wegent:prefill-message', onPrefill)
      window.removeEventListener('wegent:send-message', onSend)
    }
  }, [onSendMessage, onPrefillMessage, onTeamChange, currentTeamId, teams])

  // Flush pending action after team switching
  useEffect(() => {
    const pending = pendingActionRef.current
    if (!pending) return

    // Wait until team has switched
    if (pending.teamId && pending.teamId !== currentTeamId) return

    // Clear pending action
    pendingActionRef.current = null

    // Execute the action
    if (pending.type === 'prefill') {
      onPrefillMessage(pending.text)
    } else {
      onSendMessage(pending.text)
    }
  }, [currentTeamId, onSendMessage, onPrefillMessage])
}
