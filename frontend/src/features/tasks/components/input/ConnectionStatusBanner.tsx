// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState } from 'react'
import { WifiOff, Wifi, Check, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react'
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
  const { isConnected, reconnectAttempts, connectionError, socketUrl } = useSocket()
  const { t } = useTranslation('chat')
  const [showReconnected, setShowReconnected] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const prevConnectedRef = useRef(isConnected)

  useEffect(() => {
    // Detect state change from disconnected to connected
    if (isConnected && !prevConnectedRef.current) {
      setShowReconnected(true)
      setShowDetails(false)
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

  // Determine error type based on error message
  const getErrorType = (error: Error | null): string | null => {
    if (!error) return null
    const message = error.message.toLowerCase()
    
    // Check for timeout
    if (message.includes('timeout') || message.includes('timed out')) {
      return 'timeout'
    }
    // Check for connection refused
    if (message.includes('refused') || message.includes('econnrefused')) {
      return 'refused'
    }
    // Default to generic error
    return 'generic'
  }

  const errorType = getErrorType(connectionError)
  const hasError = errorType !== null

  // Extract backend URL from socket URL
  const backendUrl = socketUrl ? socketUrl.replace('/chat', '') : 'http://localhost:8000'
  const healthUrl = backendUrl + '/health'

  // Disconnected or reconnecting state
  return (
    <div className="mx-4 mb-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 text-sm animate-in fade-in duration-200">
      <div className="px-3 py-2 flex items-center gap-2">
        {hasError ? (
          <AlertTriangle className="h-4 w-4" />
        ) : reconnectAttempts > 0 ? (
          <Wifi className="h-4 w-4 animate-pulse" />
        ) : (
          <WifiOff className="h-4 w-4" />
        )}
        <span className="flex-1">
          {reconnectAttempts > 0
            ? t('status.reconnecting', { count: reconnectAttempts })
            : t('status.disconnected')}
        </span>
        {hasError && (
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="flex items-center gap-1 text-xs hover:underline focus:outline-none"
            aria-expanded={showDetails}
          >
            {showDetails ? (
              <>
                <ChevronUp className="h-3 w-3" />
                {t('status.hide_details')}
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3" />
                {t('status.show_details')}
              </>
            )}
          </button>
        )}
      </div>

      {/* Error details section */}
      {hasError && showDetails && (
        <div className="px-3 pb-3 border-t border-amber-200 dark:border-amber-800/30 mt-2 pt-3">
          <div className="font-semibold mb-2 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            {t('status.connection_error_title')}
          </div>
          
          {/* Specific error message */}
          <div className="mb-3 text-xs">
            {errorType === 'timeout' && (
              <div>{t('status.connection_error_timeout')}</div>
            )}
            {errorType === 'refused' && (
              <div>{t('status.connection_error_refused')}</div>
            )}
            {errorType === 'generic' && (
              <div>{t('status.connection_error_config')}</div>
            )}
          </div>

          {/* Troubleshooting steps */}
          <div className="text-xs space-y-1">
            <div className="font-semibold mb-1">{t('status.troubleshoot_title')}</div>
            <div className="space-y-1 text-amber-600 dark:text-amber-400">
              <div>{t('status.troubleshoot_check_backend', { healthUrl })}</div>
              <div>{t('status.troubleshoot_check_socket_url', { socketUrl })}</div>
              <div>{t('status.troubleshoot_check_network')}</div>
              <div>{t('status.troubleshoot_restart_services')}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ConnectionStatusBanner
