'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Flow context for managing AI Flow state.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { flowApis } from '@/apis/flow'
import type { Flow, FlowExecution, FlowExecutionStatus } from '@/types/flow'
import { useSocket } from '@/contexts/SocketContext'
import type { FlowExecutionUpdatePayload } from '@/types/socket'

interface FlowContextType {
  // Flows
  flows: Flow[]
  flowsLoading: boolean
  flowsTotal: number
  flowsPage: number
  selectedFlow: Flow | null
  setSelectedFlow: (flow: Flow | null) => void
  refreshFlows: () => Promise<void>
  loadMoreFlows: () => Promise<void>

  // Executions (Timeline)
  executions: FlowExecution[]
  executionsLoading: boolean
  executionsTotal: number
  executionsPage: number
  selectedExecution: FlowExecution | null
  setSelectedExecution: (execution: FlowExecution | null) => void
  refreshExecutions: () => Promise<void>
  loadMoreExecutions: () => Promise<void>
  /** Whether executions are currently refreshing (not initial load) */
  executionsRefreshing: boolean
  /** Cancel a running or pending execution */
  cancelExecution: (executionId: number) => Promise<void>

  // Filters
  executionFilter: {
    flowId?: number
    status?: FlowExecutionStatus[]
    startDate?: string
    endDate?: string
  }
  setExecutionFilter: (filter: FlowContextType['executionFilter']) => void

  // Active tab
  activeTab: 'timeline' | 'config'
  setActiveTab: (tab: 'timeline' | 'config') => void
}

const FlowContext = createContext<FlowContextType | undefined>(undefined)

interface FlowProviderProps {
  children: ReactNode
}

const FLOWS_PER_PAGE = 20
const EXECUTIONS_PER_PAGE = 50

export function FlowProvider({ children }: FlowProviderProps) {
  // Socket for real-time updates
  const { registerFlowHandlers } = useSocket()

  // Flows state
  const [flows, setFlows] = useState<Flow[]>([])
  const [flowsLoading, setFlowsLoading] = useState(true)
  const [flowsTotal, setFlowsTotal] = useState(0)
  const [flowsPage, setFlowsPage] = useState(1)
  const [selectedFlow, setSelectedFlow] = useState<Flow | null>(null)

  // Executions state
  const [executions, setExecutions] = useState<FlowExecution[]>([])
  const [executionsLoading, setExecutionsLoading] = useState(true)
  const [executionsRefreshing, setExecutionsRefreshing] = useState(false)
  const [executionsTotal, setExecutionsTotal] = useState(0)
  const [executionsPage, setExecutionsPage] = useState(1)
  const [selectedExecution, setSelectedExecution] = useState<FlowExecution | null>(null)

  // Filter state
  const [executionFilter, setExecutionFilter] = useState<FlowContextType['executionFilter']>({})

  // Active tab state
  const [activeTab, setActiveTab] = useState<'timeline' | 'config'>('timeline')

  // Fetch flows
  const refreshFlows = useCallback(async () => {
    setFlowsLoading(true)
    try {
      const response = await flowApis.getFlows({ page: 1, limit: FLOWS_PER_PAGE })
      setFlows(response.items)
      setFlowsTotal(response.total)
      setFlowsPage(1)
    } catch (error) {
      console.error('Failed to fetch flows:', error)
    } finally {
      setFlowsLoading(false)
    }
  }, [])

  // Load more flows
  const loadMoreFlows = useCallback(async () => {
    if (flows.length >= flowsTotal) return

    setFlowsLoading(true)
    try {
      const nextPage = flowsPage + 1
      const response = await flowApis.getFlows({
        page: nextPage,
        limit: FLOWS_PER_PAGE,
      })
      setFlows(prev => [...prev, ...response.items])
      setFlowsPage(nextPage)
    } catch (error) {
      console.error('Failed to load more flows:', error)
    } finally {
      setFlowsLoading(false)
    }
  }, [flows.length, flowsTotal, flowsPage])

  // Fetch executions
  const refreshExecutions = useCallback(async () => {
    // If we already have data, show refreshing state instead of loading
    if (executions.length > 0) {
      setExecutionsRefreshing(true)
    } else {
      setExecutionsLoading(true)
    }
    try {
      const response = await flowApis.getExecutions(
        { page: 1, limit: EXECUTIONS_PER_PAGE },
        executionFilter.flowId,
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
      const response = await flowApis.getExecutions(
        { page: nextPage, limit: EXECUTIONS_PER_PAGE },
        executionFilter.flowId,
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
    const updatedExecution = await flowApis.cancelExecution(executionId)
    // Update local state with the cancelled execution
    setExecutions(prev => prev.map(e => (e.id === executionId ? updatedExecution : e)))
  }, [])

  // Initial load
  useEffect(() => {
    refreshFlows()
    refreshExecutions()
  }, [])

  // Refresh executions when filter changes
  useEffect(() => {
    refreshExecutions()
  }, [executionFilter, refreshExecutions])

  // Handle WebSocket flow execution updates
  const handleFlowExecutionUpdate = useCallback((data: FlowExecutionUpdatePayload) => {
    setExecutions(prev => {
      // Check if this execution already exists
      const existingIndex = prev.findIndex(e => e.id === data.execution_id)
      const existingExecution = existingIndex >= 0 ? prev[existingIndex] : null

      const updatedExecution: FlowExecution = {
        id: data.execution_id,
        user_id: existingExecution?.user_id ?? 0,
        flow_id: data.flow_id,
        flow_name: data.flow_name,
        flow_display_name: data.flow_display_name,
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

  // Subscribe to WebSocket flow events
  useEffect(() => {
    const cleanup = registerFlowHandlers({
      onFlowExecutionUpdate: handleFlowExecutionUpdate,
    })
    return cleanup
  }, [registerFlowHandlers, handleFlowExecutionUpdate])

  return (
    <FlowContext.Provider
      value={{
        flows,
        flowsLoading,
        flowsTotal,
        flowsPage,
        selectedFlow,
        setSelectedFlow,
        refreshFlows,
        loadMoreFlows,
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
        executionFilter,
        setExecutionFilter,
        activeTab,
        setActiveTab,
      }}
    >
      {children}
    </FlowContext.Provider>
  )
}

export function useFlowContext() {
  const context = useContext(FlowContext)
  if (context === undefined) {
    throw new Error('useFlowContext must be used within a FlowProvider')
  }
  return context
}
