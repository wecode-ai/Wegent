// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react'
import {
  listWorkQueues,
  listQueueMessages,
  getUnreadMessageCount,
  type WorkQueue,
  type QueueMessage,
  type QueueMessageStatus,
  type UnreadCountResponse,
} from '@/apis/work-queue'
import { useSocket } from '@/contexts/SocketContext'
import { triggerInboxUnreadRefresh } from '../hooks'

interface InboxContextValue {
  // Queues
  queues: WorkQueue[]
  queuesLoading: boolean
  refreshQueues: () => Promise<void>

  // Selected queue
  selectedQueueId: number | null
  setSelectedQueueId: (id: number | null) => void

  // Messages
  messages: QueueMessage[]
  messagesLoading: boolean
  messagesTotal: number
  refreshMessages: () => Promise<void>
  loadMoreMessages: () => Promise<void>

  // Filters
  statusFilter: QueueMessageStatus | 'all'
  setStatusFilter: (status: QueueMessageStatus | 'all') => void
  sortOrder: 'asc' | 'desc'
  setSortOrder: (order: 'asc' | 'desc') => void

  // Unread count
  unreadCount: UnreadCountResponse | null
  refreshUnreadCount: () => Promise<void>
}

const InboxContext = createContext<InboxContextValue | null>(null)

export function useInboxContext() {
  const context = useContext(InboxContext)
  if (!context) {
    throw new Error('useInboxContext must be used within InboxProvider')
  }
  return context
}

interface InboxProviderProps {
  children: React.ReactNode
}

const PAGE_SIZE = 20

export function InboxProvider({ children }: InboxProviderProps) {
  const { socket } = useSocket()

  // Queues state
  const [queues, setQueues] = useState<WorkQueue[]>([])
  const [queuesLoading, setQueuesLoading] = useState(true)

  // Selected queue state
  const [selectedQueueId, setSelectedQueueId] = useState<number | null>(null)

  // Messages state
  const [messages, setMessages] = useState<QueueMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesTotal, setMessagesTotal] = useState(0)
  const [messagesPage, setMessagesPage] = useState(1)

  // Filters state
  const [statusFilter, setStatusFilter] = useState<QueueMessageStatus | 'all'>('all')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')

  // Unread count state
  const [unreadCount, setUnreadCount] = useState<UnreadCountResponse | null>(null)

  // Load queues
  const refreshQueues = useCallback(async () => {
    setQueuesLoading(true)
    try {
      const response = await listWorkQueues()
      setQueues(response.items)
      // Auto-select default queue or first queue
      if (response.items.length > 0) {
        const defaultQueue = response.items.find(q => q.isDefault)
        setSelectedQueueId(prev => {
          if (prev) return prev // Keep existing selection
          return defaultQueue?.id || response.items[0].id
        })
      }
    } catch (error) {
      console.error('Failed to load work queues:', error)
    } finally {
      setQueuesLoading(false)
    }
  }, [])

  // Load messages for selected queue
  const loadMessages = useCallback(
    async (page: number, append = false) => {
      if (!selectedQueueId) return

      setMessagesLoading(true)
      try {
        const response = await listQueueMessages(selectedQueueId, {
          status: statusFilter === 'all' ? undefined : statusFilter,
          skip: (page - 1) * PAGE_SIZE,
          limit: PAGE_SIZE,
          sort_by: 'created_at',
          sort_order: sortOrder,
        })

        if (append) {
          setMessages(prev => [...prev, ...response.items])
        } else {
          setMessages(response.items)
        }
        setMessagesTotal(response.total)
        setMessagesPage(page)
      } catch (error) {
        console.error('Failed to load queue messages:', error)
      } finally {
        setMessagesLoading(false)
      }
    },
    [selectedQueueId, statusFilter, sortOrder]
  )

  const refreshMessages = useCallback(async () => {
    setMessagesPage(1)
    await loadMessages(1, false)
  }, [loadMessages])

  const loadMoreMessages = useCallback(async () => {
    await loadMessages(messagesPage + 1, true)
  }, [loadMessages, messagesPage])

  // Load unread count
  const refreshUnreadCount = useCallback(async () => {
    try {
      const response = await getUnreadMessageCount()
      setUnreadCount(response)
    } catch (error) {
      console.error('Failed to load unread count:', error)
    }
  }, [])

  // Initial load
  useEffect(() => {
    refreshQueues()
    refreshUnreadCount()
  }, [refreshQueues, refreshUnreadCount])

  // Reload messages when queue or filters change
  useEffect(() => {
    if (selectedQueueId) {
      refreshMessages()
    }
  }, [selectedQueueId, statusFilter, sortOrder, refreshMessages])

  // Socket event handlers for real-time updates
  useEffect(() => {
    if (!socket) return

    const handleMessageReceived = (data: { queueId: number; message: QueueMessage }) => {
      // Update messages if the message is for the current queue
      if (data.queueId === selectedQueueId) {
        setMessages(prev => [data.message, ...prev])
        setMessagesTotal(prev => prev + 1)
      }
      // Update unread count
      refreshUnreadCount()
      // Trigger global refresh for TaskSidebar's unread count
      triggerInboxUnreadRefresh()
      // Update queue unread count
      setQueues(prev =>
        prev.map(q =>
          q.id === data.queueId
            ? { ...q, unreadCount: q.unreadCount + 1, messageCount: q.messageCount + 1 }
            : q
        )
      )
    }

    const handleMessageProcessed = (data: { messageId: number; result: unknown }) => {
      setMessages(prev =>
        prev.map(m =>
          m.id === data.messageId
            ? {
                ...m,
                status: 'processed' as QueueMessageStatus,
                processResult: data.result as Record<string, unknown>,
              }
            : m
        )
      )
      // Trigger global refresh for TaskSidebar's unread count
      triggerInboxUnreadRefresh()
    }

    socket.on('queue:message_received', handleMessageReceived)
    socket.on('queue:message_processed', handleMessageProcessed)

    return () => {
      socket.off('queue:message_received', handleMessageReceived)
      socket.off('queue:message_processed', handleMessageProcessed)
    }
  }, [socket, selectedQueueId, refreshUnreadCount])

  const value = useMemo(
    () => ({
      queues,
      queuesLoading,
      refreshQueues,
      selectedQueueId,
      setSelectedQueueId,
      messages,
      messagesLoading,
      messagesTotal,
      refreshMessages,
      loadMoreMessages,
      statusFilter,
      setStatusFilter,
      sortOrder,
      setSortOrder,
      unreadCount,
      refreshUnreadCount,
    }),
    [
      queues,
      queuesLoading,
      refreshQueues,
      selectedQueueId,
      messages,
      messagesLoading,
      messagesTotal,
      refreshMessages,
      loadMoreMessages,
      statusFilter,
      sortOrder,
      unreadCount,
      refreshUnreadCount,
    ]
  )

  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
}
