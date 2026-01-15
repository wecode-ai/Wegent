// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect } from 'react'
import type { Artifact } from '@/features/canvas/types'
import { useCanvasState } from '@/features/canvas/hooks/useCanvasState'
import { extractArtifact } from '@/features/canvas/hooks/useArtifact'

interface UseCanvasIntegrationOptions {
  taskId?: number
  onSendMessage?: (message: string) => void
  /** Called when canvas state is reset (e.g., on task change) */
  onReset?: () => void
}

interface CanvasIntegrationReturn {
  // Canvas visibility
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

  // Fullscreen
  isFullscreen: boolean
  toggleFullscreen: () => void

  // Version management
  handleVersionRevert: (version: number) => void

  // Quick actions
  handleQuickAction: (actionId: string, optionValue?: string) => void

  // Process stream data to extract artifacts
  processSubtaskResult: (result: unknown) => void

  // Fetch artifact with versions from API (call after streaming completes)
  fetchArtifactWithVersions: () => Promise<void>
}

/**
 * Hook to integrate Canvas functionality with ChatArea
 *
 * This hook builds on useCanvasState and adds:
 * - API integration for version revert
 * - Stream data processing for artifact extraction
 * - Quick action message generation
 * - Task change handling
 */
export function useCanvasIntegration(
  options: UseCanvasIntegrationOptions = {}
): CanvasIntegrationReturn {
  const { taskId, onSendMessage, onReset } = options

  // Use base canvas state hook
  const canvasState = useCanvasState()

  // Handle version revert - calls API to get version content and revert
  const handleVersionRevert = useCallback(
    async (version: number) => {
      if (!canvasState.artifact || !taskId) return

      // If reverting to current version, do nothing
      if (version === canvasState.artifact.version) return

      try {
        canvasState.setIsLoading(true)

        // Call API to revert to target version
        const response = await fetch(`/api/canvas/tasks/${taskId}/artifact/revert/${version}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        })

        if (!response.ok) {
          throw new Error(`Failed to revert: ${response.statusText}`)
        }

        const data = await response.json()
        if (data.artifact) {
          canvasState.setArtifact(data.artifact)
        }
      } catch (error) {
        console.error('[useCanvasIntegration] Version revert failed:', error)
        canvasState.setError(error instanceof Error ? error.message : 'Failed to revert')
      } finally {
        canvasState.setIsLoading(false)
      }
    },
    [canvasState, taskId]
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
    if (!taskId) return

    // Only fetch if we have an artifact (streaming has produced one)
    if (!canvasState.artifact) return

    try {
      const response = await fetch(`/api/canvas/tasks/${taskId}/artifact`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        // 404 is expected if no artifact was created
        if (response.status === 404) return
        throw new Error(`Failed to fetch artifact: ${response.statusText}`)
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
    }
  }, [taskId, canvasState])

  // Close fullscreen on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && canvasState.isFullscreen) {
        canvasState.setIsFullscreen(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [canvasState])

  // Reset state when taskId changes
  useEffect(() => {
    canvasState.reset()
    onReset?.()
  }, [taskId]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    // Canvas visibility
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
  }
}
