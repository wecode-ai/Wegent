// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useMemo } from 'react'
import type { Artifact, ArtifactVersion } from '../types'

interface UseCanvasStateOptions {
  onArtifactUpdate?: (artifact: Artifact) => void
}

interface CanvasStateReturn {
  // Canvas state
  canvasEnabled: boolean
  setCanvasEnabled: (enabled: boolean) => void
  toggleCanvas: () => void

  // Artifact state
  artifact: Artifact | null
  setArtifact: (artifact: Artifact | null) => void
  subtaskId: number | null
  setSubtaskId: (id: number | null) => void

  // Loading state
  isLoading: boolean
  setIsLoading: (loading: boolean) => void

  // Error state
  error: string | null
  setError: (error: string | null) => void

  // Version info (derived from artifact)
  currentVersion: number
  versions: ArtifactVersion[]

  // Content management
  updateContent: (content: string) => void
  updateTitle: (title: string) => void

  // Fullscreen
  isFullscreen: boolean
  setIsFullscreen: (fullscreen: boolean) => void
  toggleFullscreen: () => void

  // Reset all state
  reset: () => void
}

export function useCanvasState(options: UseCanvasStateOptions = {}): CanvasStateReturn {
  const { onArtifactUpdate } = options

  // Canvas enabled state
  const [canvasEnabled, setCanvasEnabled] = useState(false)

  // Artifact state
  const [artifact, setArtifactInternal] = useState<Artifact | null>(null)
  const [subtaskId, setSubtaskId] = useState<number | null>(null)

  // Loading and error state
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  // Set artifact with callback
  const setArtifact = useCallback(
    (newArtifact: Artifact | null) => {
      setArtifactInternal(newArtifact)
      if (newArtifact && onArtifactUpdate) {
        onArtifactUpdate(newArtifact)
      }
    },
    [onArtifactUpdate]
  )

  // Version info (derived from artifact)
  const currentVersion = useMemo(() => artifact?.version ?? 0, [artifact?.version])
  const versions = useMemo(() => artifact?.versions ?? [], [artifact?.versions])

  // Content management - updates local state only
  const updateContent = useCallback(
    (content: string) => {
      if (!artifact) return
      setArtifact({ ...artifact, content })
    },
    [artifact, setArtifact]
  )

  const updateTitle = useCallback(
    (title: string) => {
      if (!artifact) return
      setArtifact({ ...artifact, title })
    },
    [artifact, setArtifact]
  )

  // Reset all state
  const reset = useCallback(() => {
    setArtifactInternal(null)
    setSubtaskId(null)
    setCanvasEnabled(false)
    setIsLoading(false)
    setError(null)
    setIsFullscreen(false)
  }, [])

  return {
    // Canvas state
    canvasEnabled,
    setCanvasEnabled,
    toggleCanvas,

    // Artifact state
    artifact,
    setArtifact,
    subtaskId,
    setSubtaskId,

    // Loading state
    isLoading,
    setIsLoading,

    // Error state
    error,
    setError,

    // Version info
    currentVersion,
    versions,

    // Content management
    updateContent,
    updateTitle,

    // Fullscreen
    isFullscreen,
    setIsFullscreen,
    toggleFullscreen,

    // Reset
    reset,
  }
}
