// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { getUnreadMessageCount } from '@/apis/work-queue'
import { useSocket } from '@/contexts/SocketContext'

/**
 * Custom event name for inbox unread count refresh
 * Used to synchronize unread count between different components
 */
export const INBOX_UNREAD_REFRESH_EVENT = 'inbox:unread:refresh'

/**
 * Trigger a refresh of inbox unread count across all components
 * Call this function when marking messages as read in InboxPage
 */
export function triggerInboxUnreadRefresh() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(INBOX_UNREAD_REFRESH_EVENT))
  }
}

/**
 * Hook to fetch and manage inbox unread message count
 * Automatically refreshes when receiving WebSocket events or custom refresh events
 */
export function useInboxUnreadCount() {
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const { socket, isConnected } = useSocket()

  const fetchUnreadCount = useCallback(async () => {
    try {
      const response = await getUnreadMessageCount()
      setUnreadCount(response.total)
    } catch (error) {
      console.error('Failed to fetch inbox unread count:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    fetchUnreadCount()
  }, [fetchUnreadCount])

  // Listen for WebSocket events to refresh unread count
  useEffect(() => {
    if (!socket || !isConnected) return

    // When a new queue message is received, refresh the count
    const handleMessageReceived = () => {
      fetchUnreadCount()
    }

    // When a message is processed, refresh the count
    const handleMessageProcessed = () => {
      fetchUnreadCount()
    }

    socket.on('queue:message_received', handleMessageReceived)
    socket.on('queue:message_processed', handleMessageProcessed)

    return () => {
      socket.off('queue:message_received', handleMessageReceived)
      socket.off('queue:message_processed', handleMessageProcessed)
    }
  }, [socket, isConnected, fetchUnreadCount])

  // Listen for custom refresh events (triggered by InboxPage when marking messages as read)
  useEffect(() => {
    const handleRefreshEvent = () => {
      fetchUnreadCount()
    }

    window.addEventListener(INBOX_UNREAD_REFRESH_EVENT, handleRefreshEvent)

    return () => {
      window.removeEventListener(INBOX_UNREAD_REFRESH_EVENT, handleRefreshEvent)
    }
  }, [fetchUnreadCount])

  // Expose a method to manually refresh
  const refresh = useCallback(() => {
    fetchUnreadCount()
  }, [fetchUnreadCount])

  // Expose a method to decrement count (for optimistic updates)
  const decrementCount = useCallback((amount: number = 1) => {
    setUnreadCount(prev => Math.max(0, prev - amount))
  }, [])

  return {
    unreadCount,
    loading,
    refresh,
    decrementCount,
  }
}
