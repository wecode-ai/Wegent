// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Inline video viewer wrapper for video-type KB documents.
 *
 * Mirrors InlineImageViewer: combines video-document detection +
 * MultimodalVideoPreview rendering inside a caller-supplied wrapper className.
 * Returns null for non-video documents, so callers can render it
 * unconditionally without extra gating (symmetric to the image path).
 */

import { isVideoDocument, MultimodalVideoPreview } from './MultimodalVideoPreview'

interface DocumentLike {
  id?: number
  file_extension?: string
  attachment_id?: number | null
  name?: string
}

/**
 * Render the inline video preview for a video-type document inside a caller-
 * supplied wrapper className. Returns null when the document is not a video
 * document (no attachment_id / non-video extension).
 */
export function InlineVideoViewer({
  document,
  className,
}: {
  document: DocumentLike | null | undefined
  className?: string
}) {
  if (!isVideoDocument(document) || !document?.id) return null
  const doc = document as { id: number; name?: string }
  return (
    <div className={className}>
      <MultimodalVideoPreview documentId={doc.id} name={doc.name || 'Video document'} />
    </div>
  )
}

export { isVideoDocument }
