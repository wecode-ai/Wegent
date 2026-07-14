// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Inline image viewer wrapper for image-type KB documents.
 *
 * Extracted from the open-source DocumentContentViewer so that file carries a
 * single multimodal line per render site instead of a duplicated JSX block.
 * Combines image-document detection + MultimodalImagePreview rendering inside
 * a caller-supplied wrapper className. Returns null for non-image documents,
 * so callers can render it unconditionally without extra gating.
 */

import { isImageDocument, MultimodalImagePreview } from './MultimodalImagePreview'

interface DocumentLike {
  file_extension?: string
  attachment_id?: number | null
  name?: string
}

/**
 * Render the inline image preview for an image-type document inside a caller-
 * supplied wrapper className. Returns null when the document is not an image
 * document (no attachment_id / non-image extension).
 */
export function InlineImageViewer({
  document,
  className,
}: {
  document: DocumentLike | null | undefined
  className?: string
}) {
  if (!isImageDocument(document)) return null
  const doc = document as { attachment_id: number; name?: string }
  return (
    <div className={className}>
      <MultimodalImagePreview attachmentId={doc.attachment_id} alt={doc.name || 'Image document'} />
    </div>
  )
}

export { isImageDocument }
