// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback } from 'react'
import type { Artifact, ArtifactResult } from '../types'

interface UseArtifactStreamOptions {
  taskId?: number
  subtaskId?: number | null
  onArtifactUpdate: (artifact: Artifact) => void
  onArtifactComplete?: (artifact: Artifact) => void
}

/**
 * Hook to handle artifact streaming from existing chat stream
 * Listens to subtask stream events and extracts artifact data
 */
export function useArtifactStream(options: UseArtifactStreamOptions) {
  const { onArtifactUpdate, onArtifactComplete } = options

  // Process stream chunk to extract artifact data
  const processStreamChunk = useCallback(
    (data: { result?: ArtifactResult }) => {
      if (data.result?.type === 'artifact' && data.result.artifact) {
        onArtifactUpdate(data.result.artifact)
      }
    },
    [onArtifactUpdate]
  )

  // Process stream completion
  const processStreamComplete = useCallback(
    (data: { result?: ArtifactResult }) => {
      if (data.result?.type === 'artifact' && data.result.artifact && onArtifactComplete) {
        onArtifactComplete(data.result.artifact)
      }
    },
    [onArtifactComplete]
  )

  return {
    processStreamChunk,
    processStreamComplete,
  }
}

/**
 * Check if a subtask result contains an artifact
 */
export function isArtifactResult(result: unknown): result is ArtifactResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    'type' in result &&
    (result as { type: unknown }).type === 'artifact' &&
    'artifact' in result
  )
}

/**
 * Extract artifact from subtask result
 */
export function extractArtifact(result: unknown): Artifact | null {
  if (isArtifactResult(result)) {
    return result.artifact
  }
  return null
}
