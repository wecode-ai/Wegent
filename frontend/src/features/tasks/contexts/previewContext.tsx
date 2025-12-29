// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Preview Context for managing Workbench live preview state.
 *
 * This context manages:
 * - Preview configuration from .wegent.yaml
 * - Preview service lifecycle (start/stop)
 * - Preview status updates via WebSocket
 * - Viewport size selection for responsive preview
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from 'react'
import { previewApis } from '@/apis/preview'
import type {
  PreviewConfigResponse,
  PreviewStatus,
  ViewportSize,
} from '@/types/preview'

/**
 * Preview state for a single task
 */
interface PreviewState {
  /** Whether preview is enabled for this task */
  enabled: boolean
  /** Current preview status */
  status: PreviewStatus
  /** Preview URL if available */
  url: string | null
  /** Preview port */
  port: number | null
  /** Error message if any */
  error: string | null
  /** Whether loading config */
  isLoading: boolean
  /** Start command from config */
  startCommand: string | null
}

/**
 * Default preview state
 */
const defaultPreviewState: PreviewState = {
  enabled: false,
  status: 'disabled',
  url: null,
  port: null,
  error: null,
  isLoading: false,
  startCommand: null,
}

/**
 * Preview context type
 */
interface PreviewContextType {
  /** Current preview state */
  previewState: PreviewState
  /** Current viewport size */
  viewportSize: ViewportSize
  /** Whether preview panel is open */
  isPanelOpen: boolean
  /** Current URL path in preview */
  currentPath: string
  /** Load preview config for a task */
  loadConfig: (taskId: number) => Promise<void>
  /** Start preview service */
  startPreview: (taskId: number, force?: boolean) => Promise<void>
  /** Stop preview service */
  stopPreview: (taskId: number) => Promise<void>
  /** Refresh preview iframe */
  refreshPreview: () => void
  /** Set viewport size */
  setViewportSize: (size: ViewportSize) => void
  /** Toggle preview panel */
  togglePanel: () => void
  /** Set panel open state */
  setPanelOpen: (open: boolean) => void
  /** Navigate to a path in preview */
  navigateTo: (path: string) => void
  /** Reset preview state */
  resetState: () => void
}

const PreviewContext = createContext<PreviewContextType | undefined>(undefined)

/**
 * Preview provider component
 */
export function PreviewProvider({ children }: { children: ReactNode }) {
  const [previewState, setPreviewState] = useState<PreviewState>(defaultPreviewState)
  const [viewportSize, setViewportSize] = useState<ViewportSize>('desktop')
  const [isPanelOpen, setIsPanelOpen] = useState(false)
  const [currentPath, setCurrentPath] = useState('/')
  const [refreshKey, setRefreshKey] = useState(0)

  /**
   * Load preview configuration for a task
   */
  const loadConfig = useCallback(async (taskId: number) => {
    setPreviewState(prev => ({ ...prev, isLoading: true, error: null }))

    try {
      const config: PreviewConfigResponse = await previewApis.getConfig(taskId)

      setPreviewState({
        enabled: config.enabled,
        status: config.status,
        url: config.url || null,
        port: config.port || null,
        error: config.error || null,
        isLoading: false,
        startCommand: config.start_command || null,
      })

      // Auto-open panel if preview is enabled and ready
      if (config.enabled && config.status === 'ready') {
        setIsPanelOpen(true)
      }
    } catch (error) {
      console.error('[PreviewContext] Error loading config:', error)
      setPreviewState({
        ...defaultPreviewState,
        error: error instanceof Error ? error.message : 'Failed to load config',
        isLoading: false,
      })
    }
  }, [])

  /**
   * Start preview service
   */
  const startPreview = useCallback(async (taskId: number, force = false) => {
    setPreviewState(prev => ({
      ...prev,
      status: 'starting',
      error: null,
    }))

    try {
      const response = await previewApis.start(taskId, { force })

      setPreviewState(prev => ({
        ...prev,
        status: response.status,
        url: response.url || null,
        error: response.success ? null : response.message,
      }))

      if (response.success) {
        setIsPanelOpen(true)
      }
    } catch (error) {
      console.error('[PreviewContext] Error starting preview:', error)
      setPreviewState(prev => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to start preview',
      }))
    }
  }, [])

  /**
   * Stop preview service
   */
  const stopPreview = useCallback(async (taskId: number) => {
    try {
      await previewApis.stop(taskId)
      setPreviewState(prev => ({
        ...prev,
        status: 'stopped',
        url: null,
      }))
    } catch (error) {
      console.error('[PreviewContext] Error stopping preview:', error)
    }
  }, [])

  /**
   * Refresh preview iframe
   */
  const refreshPreview = useCallback(() => {
    setRefreshKey(prev => prev + 1)
  }, [])

  /**
   * Toggle preview panel
   */
  const togglePanel = useCallback(() => {
    setIsPanelOpen(prev => !prev)
  }, [])

  /**
   * Set panel open state
   */
  const setPanelOpen = useCallback((open: boolean) => {
    setIsPanelOpen(open)
  }, [])

  /**
   * Navigate to a path in preview
   */
  const navigateTo = useCallback((path: string) => {
    setCurrentPath(path.startsWith('/') ? path : `/${path}`)
  }, [])

  /**
   * Reset preview state
   */
  const resetState = useCallback(() => {
    setPreviewState(defaultPreviewState)
    setCurrentPath('/')
  }, [])

  // Build the full preview URL with current path
  const fullUrl = previewState.url
    ? `${previewState.url}${currentPath}`
    : null

  return (
    <PreviewContext.Provider
      value={{
        previewState: {
          ...previewState,
          url: fullUrl,
        },
        viewportSize,
        isPanelOpen,
        currentPath,
        loadConfig,
        startPreview,
        stopPreview,
        refreshPreview,
        setViewportSize,
        togglePanel,
        setPanelOpen,
        navigateTo,
        resetState,
      }}
    >
      {children}
    </PreviewContext.Provider>
  )
}

/**
 * Hook to use preview context
 */
export function usePreviewContext(): PreviewContextType {
  const context = useContext(PreviewContext)
  if (!context) {
    throw new Error('usePreviewContext must be used within a PreviewProvider')
  }
  return context
}

/**
 * Hook to get preview state for a specific task
 */
export function usePreview(taskId: number | undefined) {
  const context = usePreviewContext()

  useEffect(() => {
    if (taskId) {
      context.loadConfig(taskId)
    } else {
      context.resetState()
    }
  }, [taskId]) // eslint-disable-line react-hooks/exhaustive-deps

  return context
}
