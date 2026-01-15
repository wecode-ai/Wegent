// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useMemo } from 'react'
import type { Artifact } from '@/features/canvas/types'
import { useCanvasState } from '@/features/canvas/hooks/useCanvasState'
import { extractArtifact } from '@/features/canvas/hooks/useArtifact'

// Error messages for user-friendly display
const ERROR_MESSAGES = {
  NETWORK_ERROR: '网络错误，请检查网络连接后重试',
  VERSION_NOT_FOUND: '版本不存在',
  REVERT_FAILED: '恢复版本失败，请稍后重试',
  FETCH_FAILED: '获取内容失败，请稍后重试',
  TIMEOUT: '请求超时，请稍后重试',
} as const

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 2,
  retryDelay: 1000, // ms
} as const

interface UseCanvasIntegrationOptions {
  taskId?: number
  onSendMessage?: (message: string) => void
  /** Called when canvas state is reset (e.g., on task change) */
  onReset?: () => void
}

interface CanvasIntegrationReturn {
  // Canvas visibility - unified state
  canvasEnabled: boolean
  setCanvasEnabled: (enabled: boolean) => void
  toggleCanvas: () => void

  // Current artifact
  artifact: Artifact | null
  setArtifact: (artifact: Artifact | null) => void
  subtaskId: number | null
  setSubtaskId: (id: number | null) => void

  // Loading state
  isCanvasLoading: boolean
  setIsCanvasLoading: (loading: boolean) => void

  // Error state
  error: string | null
  clearError: () => void

  // Fullscreen
  isFullscreen: boolean
  toggleFullscreen: () => void

  // Version management
  handleVersionRevert: (version: number) => Promise<void>

  // Quick actions
  handleQuickAction: (actionId: string, optionValue?: string) => void

  // Process stream data to extract artifacts
  processSubtaskResult: (result: unknown) => void

  // Fetch artifact with versions from API (call after streaming completes)
  fetchArtifactWithVersions: () => Promise<void>

  // Reset state
  reset: () => void
}

/**
 * Helper function to perform fetch with retry
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries: number = RETRY_CONFIG.maxRetries
): Promise<Response> {
  let lastError: Error | null = null

  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 30000) // 30s timeout

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)
      return response
    } catch (error) {
      lastError = error as Error
      if (i < retries) {
        await new Promise(resolve => setTimeout(resolve, RETRY_CONFIG.retryDelay * (i + 1)))
      }
    }
  }

  throw lastError
}

/**
 * Hook to integrate Canvas functionality with ChatArea
 *
 * This hook builds on useCanvasState and adds:
 * - API integration for version revert with retry logic
 * - Stream data processing for artifact extraction
 * - Quick action message generation
 * - Task change handling
 * - Unified state management (single source of truth)
 */
export function useCanvasIntegration(
  options: UseCanvasIntegrationOptions = {}
): CanvasIntegrationReturn {
  const { taskId, onSendMessage, onReset } = options

  // Use base canvas state hook - this is the single source of truth
  const canvasState = useCanvasState()

  // Track if we're currently fetching to prevent duplicate requests
  const isFetchingRef = useRef(false)

  // Stable reference for taskId to avoid stale closures
  const taskIdRef = useRef(taskId)
  useEffect(() => {
    taskIdRef.current = taskId
  }, [taskId])

  // Clear error helper
  const clearError = useCallback(() => {
    canvasState.setError(null)
  }, [canvasState])

  // Handle version revert - calls API to get version content and revert
  const handleVersionRevert = useCallback(
    async (version: number) => {
      const currentTaskId = taskIdRef.current
      if (!canvasState.artifact || !currentTaskId) return

      // If reverting to current version, do nothing
      if (version === canvasState.artifact.version) return

      try {
        canvasState.setIsLoading(true)
        canvasState.setError(null)

        const response = await fetchWithRetry(
          `/api/canvas/tasks/${currentTaskId}/artifact/revert/${version}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error(ERROR_MESSAGES.VERSION_NOT_FOUND)
          } else if (response.status === 409) {
            // Conflict - version mismatch, refetch and retry
            const errorData = await response.json().catch(() => ({}))
            throw new Error(errorData.detail || ERROR_MESSAGES.REVERT_FAILED)
          }
          throw new Error(ERROR_MESSAGES.REVERT_FAILED)
        }

        const data = await response.json()
        if (data.artifact) {
          canvasState.setArtifact(data.artifact)
        }
      } catch (error) {
        console.error('[useCanvasIntegration] Version revert failed:', error)
        const errorMessage =
          error instanceof Error
            ? error.message.includes('aborted')
              ? ERROR_MESSAGES.TIMEOUT
              : error.message
            : ERROR_MESSAGES.REVERT_FAILED
        canvasState.setError(errorMessage)
      } finally {
        canvasState.setIsLoading(false)
      }
    },
    [canvasState]
  )

  // Handle quick action - sends message through chat
  const handleQuickAction = useCallback(
    (actionId: string, optionValue?: string) => {
      if (!onSendMessage) return

      // Build the quick action message
      let message = `[canvas:${actionId}]`
      if (optionValue) {
        message += ` ${optionValue}`
      }

      // Send the message through the chat
      onSendMessage(message)
    },
    [onSendMessage]
  )

  // Process subtask result to extract artifacts
  const processSubtaskResult = useCallback(
    (result: unknown) => {
      const extractedArtifact = extractArtifact(result)
      if (extractedArtifact) {
        canvasState.setArtifact(extractedArtifact)
        // Auto-enable canvas when artifact is generated
        if (!canvasState.canvasEnabled) {
          canvasState.setCanvasEnabled(true)
        }
      }
    },
    [canvasState]
  )

  // Fetch artifact with versions from API
  // Call this after streaming completes to get the full artifact with version history
  const fetchArtifactWithVersions = useCallback(async () => {
    const currentTaskId = taskIdRef.current
    if (!currentTaskId) return

    // Only fetch if we have an artifact (streaming has produced one)
    if (!canvasState.artifact) return

    // Prevent duplicate fetches
    if (isFetchingRef.current) return
    isFetchingRef.current = true

    try {
      const response = await fetchWithRetry(`/api/canvas/tasks/${currentTaskId}/artifact`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        // 404 is expected if no artifact was created
        if (response.status === 404) return
        throw new Error(ERROR_MESSAGES.FETCH_FAILED)
      }

      const data = await response.json()
      if (data.artifact) {
        console.log(
          '[useCanvasIntegration] Fetched artifact with versions:',
          data.artifact.id,
          'versions count:',
          data.artifact.versions?.length
        )
        canvasState.setArtifact(data.artifact)
      }
    } catch (error) {
      console.error('[useCanvasIntegration] Failed to fetch artifact with versions:', error)
      // Don't set error state - we still have the artifact from streaming
    } finally {
      isFetchingRef.current = false
    }
  }, [canvasState])

  // Close fullscreen on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && canvasState.isFullscreen) {
        canvasState.setIsFullscreen(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [canvasState.isFullscreen, canvasState.setIsFullscreen])

  // Stable reset function
  const reset = useCallback(() => {
    canvasState.reset()
    isFetchingRef.current = false
    onReset?.()
  }, [canvasState, onReset])

  // Reset state when taskId changes
  useEffect(() => {
    reset()
  }, [taskId]) // eslint-disable-line react-hooks/exhaustive-deps
  // Note: We intentionally only depend on taskId here to trigger reset on task change

  // Return stable object using useMemo to prevent unnecessary re-renders
  return useMemo(
    () => ({
      // Canvas visibility - from unified state
      canvasEnabled: canvasState.canvasEnabled,
      setCanvasEnabled: canvasState.setCanvasEnabled,
      toggleCanvas: canvasState.toggleCanvas,

      // Current artifact
      artifact: canvasState.artifact,
      setArtifact: canvasState.setArtifact,
      subtaskId: canvasState.subtaskId,
      setSubtaskId: canvasState.setSubtaskId,

      // Loading state (renamed for clarity)
      isCanvasLoading: canvasState.isLoading,
      setIsCanvasLoading: canvasState.setIsLoading,

      // Error state
      error: canvasState.error,
      clearError,

      // Fullscreen
      isFullscreen: canvasState.isFullscreen,
      toggleFullscreen: canvasState.toggleFullscreen,

      // Version management
      handleVersionRevert,

      // Quick actions
      handleQuickAction,

      // Process stream data
      processSubtaskResult,

      // Fetch artifact with versions from API
      fetchArtifactWithVersions,

      // Reset
      reset,
    }),
    [
      canvasState.canvasEnabled,
      canvasState.setCanvasEnabled,
      canvasState.toggleCanvas,
      canvasState.artifact,
      canvasState.setArtifact,
      canvasState.subtaskId,
      canvasState.setSubtaskId,
      canvasState.isLoading,
      canvasState.setIsLoading,
      canvasState.error,
      canvasState.isFullscreen,
      canvasState.toggleFullscreen,
      clearError,
      handleVersionRevert,
      handleQuickAction,
      processSubtaskResult,
      fetchArtifactWithVersions,
      reset,
    ]
  )
}
