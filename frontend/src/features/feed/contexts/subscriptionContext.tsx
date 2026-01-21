'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription context for managing Subscription state.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { subscriptionApis } from '@/apis/subscription'
import type {
  Subscription,
  BackgroundExecution,
  BackgroundExecutionStatus,
} from '@/types/subscription'
import { useSocket } from '@/contexts/SocketContext'
import type { BackgroundExecutionUpdatePayload } from '@/types/socket'

interface SubscriptionContextType {
  // Subscriptions
  subscriptions: Subscription[]
  subscriptionsLoading: boolean
  subscriptionsTotal: number
  subscriptionsPage: number
  selectedSubscription: Subscription | null
  setSelectedSubscription: (subscription: Subscription | null) => void
  refreshSubscriptions: () => Promise<void>
  loadMoreSubscriptions: () => Promise<void>

  // Executions (Timeline)
  executions: BackgroundExecution[]
  executionsLoading: boolean
  executionsTotal: number
  executionsPage: number
  selectedExecution: BackgroundExecution | null
  setSelectedExecution: (execution: BackgroundExecution | null) => void
  refreshExecutions: () => Promise<void>
  loadMoreExecutions: () => Promise<void>
  /** Whether executions are currently refreshing (not initial load) */
  executionsRefreshing: boolean
  /** Cancel a running or pending execution */
  cancelExecution: (executionId: number) => Promise<void>
  /** Delete an execution record (only terminal states) */
  deleteExecution: (executionId: number) => Promise<void>

  // Filters
  executionFilter: {
    subscriptionId?: number
    status?: BackgroundExecutionStatus[]
    startDate?: string
    endDate?: string
  }
  setExecutionFilter: (filter: SubscriptionContextType['executionFilter']) => void

  // Active tab
  activeTab: 'timeline' | 'config'
  setActiveTab: (tab: 'timeline' | 'config') => void
}

const SubscriptionContext = createContext<SubscriptionContextType | undefined>(undefined)

interface SubscriptionProviderProps {
  children: ReactNode
}

const SUBSCRIPTIONS_PER_PAGE = 20
const EXECUTIONS_PER_PAGE = 50

export function SubscriptionProvider({ children }: SubscriptionProviderProps) {
  // Socket for real-time updates
  const { registerBackgroundExecutionHandlers } = useSocket()

  // Subscriptions state
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [subscriptionsLoading, setSubscriptionsLoading] = useState(true)
  const [subscriptionsTotal, setSubscriptionsTotal] = useState(0)
  const [subscriptionsPage, setSubscriptionsPage] = useState(1)
  const [selectedSubscription, setSelectedSubscription] = useState<Subscription | null>(null)

  // Executions state
  const [executions, setExecutions] = useState<BackgroundExecution[]>([])
  const [executionsLoading, setExecutionsLoading] = useState(true)
  const [executionsRefreshing, setExecutionsRefreshing] = useState(false)
  const [executionsTotal, setExecutionsTotal] = useState(0)
  const [executionsPage, setExecutionsPage] = useState(1)
  const [selectedExecution, setSelectedExecution] = useState<BackgroundExecution | null>(null)

  // Filter state
  const [executionFilter, setExecutionFilter] = useState<
    SubscriptionContextType['executionFilter']
  >({})

  // Active tab state
  const [activeTab, setActiveTab] = useState<'timeline' | 'config'>('timeline')

  // Fetch subscriptions
  const refreshSubscriptions = useCallback(async () => {
    setSubscriptionsLoading(true)
    try {
      const response = await subscriptionApis.getSubscriptions({
        page: 1,
        limit: SUBSCRIPTIONS_PER_PAGE,
      })
      setSubscriptions(response.items)
      setSubscriptionsTotal(response.total)
      setSubscriptionsPage(1)
    } catch (error) {
      console.error('Failed to fetch subscriptions:', error)
    } finally {
      setSubscriptionsLoading(false)
    }
  }, [])

  // Load more subscriptions
  const loadMoreSubscriptions = useCallback(async () => {
    if (subscriptions.length >= subscriptionsTotal) return

    setSubscriptionsLoading(true)
    try {
      const nextPage = subscriptionsPage + 1
      const response = await subscriptionApis.getSubscriptions({
        page: nextPage,
        limit: SUBSCRIPTIONS_PER_PAGE,
      })
      setSubscriptions(prev => [...prev, ...response.items])
      setSubscriptionsPage(nextPage)
    } catch (error) {
      console.error('Failed to load more subscriptions:', error)
    } finally {
      setSubscriptionsLoading(false)
    }
  }, [subscriptions.length, subscriptionsTotal, subscriptionsPage])

  // Fetch executions
  const refreshExecutions = useCallback(async () => {
    // If we already have data, show refreshing state instead of loading
    if (executions.length > 0) {
      setExecutionsRefreshing(true)
    } else {
      setExecutionsLoading(true)
    }
    try {
      const response = await subscriptionApis.getExecutions(
        { page: 1, limit: EXECUTIONS_PER_PAGE },
        executionFilter.subscriptionId,
        executionFilter.status,
        executionFilter.startDate,
        executionFilter.endDate
      )
      setExecutions(response.items)
      setExecutionsTotal(response.total)
      setExecutionsPage(1)
    } catch (error) {
      console.error('Failed to fetch executions:', error)
    } finally {
      setExecutionsLoading(false)
      setExecutionsRefreshing(false)
    }
  }, [executionFilter, executions.length])

  // Load more executions
  const loadMoreExecutions = useCallback(async () => {
    if (executions.length >= executionsTotal) return

    setExecutionsLoading(true)
    try {
      const nextPage = executionsPage + 1
      const response = await subscriptionApis.getExecutions(
        { page: nextPage, limit: EXECUTIONS_PER_PAGE },
        executionFilter.subscriptionId,
        executionFilter.status,
        executionFilter.startDate,
        executionFilter.endDate
      )
      setExecutions(prev => [...prev, ...response.items])
      setExecutionsPage(nextPage)
    } catch (error) {
      console.error('Failed to load more executions:', error)
    } finally {
      setExecutionsLoading(false)
    }
  }, [executions.length, executionsTotal, executionsPage, executionFilter])

  // Cancel an execution
  const cancelExecution = useCallback(async (executionId: number) => {
    const updatedExecution = await subscriptionApis.cancelExecution(executionId)
    // Update local state with the cancelled execution
    setExecutions(prev => prev.map(e => (e.id === executionId ? updatedExecution : e)))
  }, [])

  // Delete an execution
  const deleteExecution = useCallback(async (executionId: number) => {
    await subscriptionApis.deleteExecution(executionId)
    // Remove from local state
    setExecutions(prev => prev.filter(e => e.id !== executionId))
    // Update total count
    setExecutionsTotal(prev => Math.max(0, prev - 1))
  }, [])

  // Initial load
  useEffect(() => {
    refreshSubscriptions()
    refreshExecutions()
  }, [])

  // Refresh executions when filter changes
  useEffect(() => {
    refreshExecutions()
  }, [executionFilter, refreshExecutions])

  // Handle WebSocket background execution updates
  const handleBackgroundExecutionUpdate = useCallback((data: BackgroundExecutionUpdatePayload) => {
    setExecutions(prev => {
      // Check if this execution already exists
      const existingIndex = prev.findIndex(e => e.id === data.execution_id)
      const existingExecution = existingIndex >= 0 ? prev[existingIndex] : null

      const updatedExecution: BackgroundExecution = {
        id: data.execution_id,
        user_id: existingExecution?.user_id ?? 0,
        subscription_id: data.subscription_id,
        subscription_name: data.subscription_name,
        subscription_display_name: data.subscription_display_name,
        team_name: data.team_name,
        status: data.status,
        task_id: data.task_id,
        task_type: data.task_type,
        prompt: data.prompt || '',
        result_summary: data.result_summary,
        error_message: data.error_message,
        trigger_type: existingExecution?.trigger_type ?? 'cron',
        trigger_reason: data.trigger_reason,
        retry_attempt: existingExecution?.retry_attempt ?? 0,
        created_at: data.created_at,
        updated_at: data.updated_at,
      }

      if (existingIndex >= 0) {
        // Update existing execution
        const newList = [...prev]
        newList[existingIndex] = updatedExecution
        return newList
      } else {
        // Add new execution at the beginning
        return [updatedExecution, ...prev]
      }
    })
  }, [])

  // Subscribe to WebSocket background execution events
  useEffect(() => {
    const cleanup = registerBackgroundExecutionHandlers({
      onBackgroundExecutionUpdate: handleBackgroundExecutionUpdate,
    })
    return cleanup
  }, [registerBackgroundExecutionHandlers, handleBackgroundExecutionUpdate])

  return (
    <SubscriptionContext.Provider
      value={{
        subscriptions,
        subscriptionsLoading,
        subscriptionsTotal,
        subscriptionsPage,
        selectedSubscription,
        setSelectedSubscription,
        refreshSubscriptions,
        loadMoreSubscriptions,
        executions,
        executionsLoading,
        executionsRefreshing,
        executionsTotal,
        executionsPage,
        selectedExecution,
        setSelectedExecution,
        refreshExecutions,
        loadMoreExecutions,
        cancelExecution,
        deleteExecution,
        executionFilter,
        setExecutionFilter,
        activeTab,
        setActiveTab,
      }}
    >
      {children}
    </SubscriptionContext.Provider>
  )
}

export function useSubscriptionContext() {
  const context = useContext(SubscriptionContext)
  if (context === undefined) {
    throw new Error('useSubscriptionContext must be used within a SubscriptionProvider')
  }
  return context
}
