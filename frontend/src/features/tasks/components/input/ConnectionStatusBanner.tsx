// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState } from 'react'
import { WifiOff, Wifi, Check } from 'lucide-react'
import { useSocket } from '@/contexts/SocketContext'
import { useTranslation } from '@/hooks/useTranslation'

/** Delay before showing disconnection banner (ms) */
const DISCONNECTION_DISPLAY_DELAY = 5000

/**
 * ConnectionStatusBanner Component
 *
 * Displays WebSocket connection status to users in the chat input area.
 * Shows different states:
 * - Disconnected: When connection is lost for more than 5 seconds
 * - Reconnecting: During reconnection attempts with attempt count (after 5s delay)
 * - Reconnected: Briefly shown after successful reconnection (auto-hides after 3s)
 *
 * The 5-second delay prevents UI flicker during brief network interruptions.
 */
export function ConnectionStatusBanner() {
  const { isConnected, reconnectAttempts } = useSocket()
  const { t } = useTranslation('chat')
  const [showReconnected, setShowReconnected] = useState(false)
  const [showDisconnected, setShowDisconnected] = useState(false)
  const prevConnectedRef = useRef(isConnected)
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Clear any pending disconnect timer when connection state changes
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current)
      disconnectTimerRef.current = null
    }

    if (isConnected) {
      // Detect state change from disconnected to connected (reconnection success)
      // Only show "reconnected" message if the disconnection banner was already shown
      // This prevents showing "reconnected" for brief disconnections under 5 seconds
      if (!prevConnectedRef.current && showDisconnected) {
        setShowReconnected(true)
        setTimeout(() => setShowReconnected(false), 3000)
      }

      // Connected: hide disconnection banner
      setShowDisconnected(false)
    } else {
      // Disconnected: show banner only after 5 seconds delay
      // This prevents UI flicker during brief network interruptions
      disconnectTimerRef.current = setTimeout(() => {
        setShowDisconnected(true)
      }, DISCONNECTION_DISPLAY_DELAY)
    }

    prevConnectedRef.current = isConnected

    return () => {
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current)
      }
    }
  }, [isConnected, showDisconnected])

  // Don't render anything when connected and no success message to show
  if (isConnected && !showReconnected) return null

  // Reconnection success message
  if (isConnected && showReconnected) {
    return (
      <div className="mx-4 mb-2 px-3 py-2 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-sm flex items-center gap-2 animate-in fade-in duration-200">
        <Check className="h-4 w-4" />
        <span>{t('status.reconnected')}</span>
      </div>
    )
  }

  // Don't show disconnection banner until delay has passed
  if (!showDisconnected) return null

  // Disconnected or reconnecting state
  return (
    <div className="mx-4 mb-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 text-sm flex items-center gap-2 animate-in fade-in duration-200">
      {reconnectAttempts > 0 ? (
        <>
          <Wifi className="h-4 w-4 animate-pulse" />
          <span>{t('status.reconnecting', { count: reconnectAttempts })}</span>
        </>
      ) : (
        <>
          <WifiOff className="h-4 w-4" />
          <span>{t('status.disconnected')}</span>
        </>
      )}
    </div>
  )
}

export default ConnectionStatusBanner
