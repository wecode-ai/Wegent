// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState } from 'react'
import { WifiOff, Wifi, Check } from 'lucide-react'
import { useSocket } from '@/contexts/SocketContext'
import { useTranslation } from '@/hooks/useTranslation'

/**
 * ConnectionStatusBanner Component
 *
 * Displays WebSocket connection status to users in the chat input area.
 * Shows different states:
 * - Disconnected: When connection is lost
 * - Reconnecting: During reconnection attempts with attempt count
 * - Reconnected: Briefly shown after successful reconnection (auto-hides after 3s)
 */
export function ConnectionStatusBanner() {
  const { isConnected, reconnectAttempts } = useSocket()
  const { t } = useTranslation('chat')
  const [showReconnected, setShowReconnected] = useState(false)
  const prevConnectedRef = useRef(isConnected)

  useEffect(() => {
    // Detect state change from disconnected to connected
    if (isConnected && !prevConnectedRef.current) {
      setShowReconnected(true)
      const timer = setTimeout(() => setShowReconnected(false), 3000)
      return () => clearTimeout(timer)
    }
    prevConnectedRef.current = isConnected
  }, [isConnected])

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
