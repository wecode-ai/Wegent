// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for multimodal document actions (re-analyze, video download).
 *
 * Encapsulates the multimodal-specific logic that DocumentItem needs:
 * - isMultimodalDoc classification (video/image)
 * - canReanalyze gate (multimodal + idle + callback provided)
 * - handleReanalyze event handler
 * - handleMultimodalDownload (routes videos to the knowledge-base video-download endpoint)
 *
 * Pattern follows useDeviceVncState.
 */

import { useCallback } from 'react'
import { isVideoFileName, isImageExtension } from '@/apis/attachments'
import type { KnowledgeDocument } from '@/types/knowledge'
import { useMultimodalFeatureEnabled } from './useMultimodalFeatureEnabled'

export interface MultimodalDocActions {
  /** True if the document is a video or image file */
  isMultimodalDoc: boolean
  /** True if re-analyze is available (multimodal + idle + callback provided) */
  canReanalyze: boolean
  /** Re-analyze click handler */
  handleReanalyze: (e: React.MouseEvent) => void
}

export function useMultimodalDocActions(
  document: KnowledgeDocument,
  onReanalyze: ((doc: KnowledgeDocument) => void) | undefined,
  showIndexingState: boolean
): MultimodalDocActions {
  // Gate re-analyze by the global pipeline switch: when disabled, the
  // "modify prompt & re-analyze" action is hidden even on already-multimodal
  // documents (the backend won't re-run Gemini anyway).
  const featureEnabled = useMultimodalFeatureEnabled()
  // Normalize file extension to dot-prefixed form.
  const normalizedExt = `.${(document.file_extension || '').replace(/^\.+/, '')}`
  const isMultimodalDoc = isVideoFileName(document.name) || isImageExtension(normalizedExt)
  // Gate on source_type=file + attachment_id: a table/web doc could have a
  // multimodal-looking name (e.g. "demo.mp4") but has no attachment to stage.
  const canReanalyze =
    featureEnabled &&
    isMultimodalDoc &&
    document.source_type === 'file' &&
    !!document.attachment_id &&
    !!onReanalyze &&
    !showIndexingState

  const handleReanalyze = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onReanalyze?.(document)
    },
    [onReanalyze, document]
  )

  return {
    isMultimodalDoc,
    canReanalyze,
    handleReanalyze,
  }
}
