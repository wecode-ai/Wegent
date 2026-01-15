// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useMemo } from 'react'
import type { Artifact, ArtifactVersion } from '../types'

interface UseCanvasStateOptions {
  taskId?: number
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

  // Version management
  currentVersion: number
  versions: ArtifactVersion[]
  revertToVersion: (version: number) => void

  // Content management
  updateContent: (content: string) => void
  updateTitle: (title: string) => void

  // Highlighted text (for quick actions)
  highlightedText: string | null
  setHighlightedText: (text: string | null) => void
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

  // Highlighted text for quick actions
  const [highlightedText, setHighlightedText] = useState<string | null>(null)

  // Toggle canvas
  const toggleCanvas = useCallback(() => {
    setCanvasEnabled(prev => !prev)
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

  // Version management
  const currentVersion = useMemo(() => artifact?.version ?? 0, [artifact?.version])
  const versions = useMemo(() => artifact?.versions ?? [], [artifact?.versions])

  const revertToVersion = useCallback(
    (version: number) => {
      if (!artifact) return

      const targetVersion = artifact.versions.find(v => v.version === version)
      if (!targetVersion) return

      const newVersionNumber = artifact.version + 1
      const newVersion: ArtifactVersion = {
        version: newVersionNumber,
        content: targetVersion.content,
        created_at: new Date().toISOString(),
      }

      const updatedArtifact: Artifact = {
        ...artifact,
        content: targetVersion.content,
        version: newVersionNumber,
        versions: [...artifact.versions, newVersion],
      }

      setArtifact(updatedArtifact)
    },
    [artifact, setArtifact]
  )

  // Content management
  const updateContent = useCallback(
    (content: string) => {
      if (!artifact) return

      const newVersionNumber = artifact.version + 1
      const newVersion: ArtifactVersion = {
        version: newVersionNumber,
        content,
        created_at: new Date().toISOString(),
      }

      const updatedArtifact: Artifact = {
        ...artifact,
        content,
        version: newVersionNumber,
        versions: [...artifact.versions, newVersion],
      }

      setArtifact(updatedArtifact)
    },
    [artifact, setArtifact]
  )

  const updateTitle = useCallback(
    (title: string) => {
      if (!artifact) return

      const updatedArtifact: Artifact = {
        ...artifact,
        title,
      }

      setArtifact(updatedArtifact)
    },
    [artifact, setArtifact]
  )

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

    // Version management
    currentVersion,
    versions,
    revertToVersion,

    // Content management
    updateContent,
    updateTitle,

    // Highlighted text
    highlightedText,
    setHighlightedText,
  }
}
