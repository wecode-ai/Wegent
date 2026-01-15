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
  const { onSendMessage } = options

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
    setCanvasEnabled(prev => !prev)
  }, [])

  // Toggle fullscreen
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen(prev => !prev)
  }, [])

  // Handle version revert
  const handleVersionRevert = useCallback(
    (version: number) => {
      if (!artifact) return

      const targetVersion = artifact.versions.find(v => v.version === version)
      if (!targetVersion) return

      const newVersionNumber = artifact.version + 1
      const newVersion = {
        version: newVersionNumber,
        content: targetVersion.content,
        created_at: new Date().toISOString(),
      }

      setArtifact({
        ...artifact,
        content: targetVersion.content,
        version: newVersionNumber,
        versions: [...artifact.versions, newVersion],
      })
    },
    [artifact]
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
