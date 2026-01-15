// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect } from 'react'
import type { Artifact } from '@/features/canvas/types'
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
}

/**
 * Hook to integrate Canvas functionality with ChatArea
 * Handles canvas state, artifact extraction from stream, and quick actions
 */
export function useCanvasIntegration(
  options: UseCanvasIntegrationOptions = {}
): CanvasIntegrationReturn {
  const { taskId, onSendMessage, onReset } = options

  // Canvas visibility
  const [canvasEnabled, setCanvasEnabled] = useState(false)

  // Artifact state
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [subtaskId, setSubtaskId] = useState<number | null>(null)

  // Loading state
  const [isCanvasLoading, setIsCanvasLoading] = useState(false)

  // Fullscreen state
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Toggle canvas
  const toggleCanvas = useCallback(() => {
    console.log('[useCanvasIntegration] toggleCanvas called, current:', canvasEnabled)
    setCanvasEnabled(prev => !prev)
  }, [canvasEnabled])

  // Toggle fullscreen
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen(prev => !prev)
  }, [])

  // Handle version revert - calls API to get version content and revert
  const handleVersionRevert = useCallback(
    async (version: number) => {
      if (!artifact || !taskId) return

      // If reverting to current version, do nothing
      if (version === artifact.version) return

      try {
        setIsCanvasLoading(true)

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
          setArtifact(data.artifact)
        }
      } catch (error) {
        console.error('[useCanvasIntegration] Version revert failed:', error)
      } finally {
        setIsCanvasLoading(false)
      }
    },
    [artifact, taskId]
  )

  // Handle quick action
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
        console.log('[useCanvasIntegration] Updating artifact:', extractedArtifact.id, 'version:', extractedArtifact.version)
        setArtifact(extractedArtifact)
        // Auto-enable canvas when artifact is generated
        if (!canvasEnabled) {
          setCanvasEnabled(true)
        }
      }
    },
    [canvasEnabled]
  )

  // Close fullscreen on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isFullscreen])

  // Reset state when taskId changes
  useEffect(() => {
    // Reset artifact and canvas state when switching tasks
    console.log('[useCanvasIntegration] Task changed to:', taskId, '- resetting state')
    setArtifact(null)
    setSubtaskId(null)
    setCanvasEnabled(false)
    setIsCanvasLoading(false)
    setIsFullscreen(false)
    onReset?.()
  }, [taskId, onReset])

  return {
    // Canvas visibility
    canvasEnabled,
    setCanvasEnabled,
    toggleCanvas,

    // Current artifact
    artifact,
    setArtifact,
    subtaskId,
    setSubtaskId,

    // Loading state
    isCanvasLoading,
    setIsCanvasLoading,

    // Fullscreen
    isFullscreen,
    toggleFullscreen,

    // Version management
    handleVersionRevert,

    // Quick actions
    handleQuickAction,

    // Process stream data
    processSubtaskResult,
  }
}
