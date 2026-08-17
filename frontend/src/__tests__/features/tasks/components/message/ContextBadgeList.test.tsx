// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { ContextBadgeList } from '@/features/tasks/components/message/ContextBadgeList'
import type { SubtaskContextBrief } from '@/types/api'

jest.mock('@/features/tasks/components/input/AttachmentPreview', () => ({
  __esModule: true,
  default: ({ attachment, compact }: { attachment: { filename: string }; compact: boolean }) => (
    <div data-testid={`attachment-${attachment.filename}`} data-compact={String(compact)} />
  ),
}))

jest.mock('@/features/tasks/components/message/ImageGallery', () => ({
  __esModule: true,
  default: ({ images }: { images: Array<{ url: string; attachmentId?: number }> }) => (
    <div
      data-testid="generated-image-gallery"
      data-url={images[0]?.url}
      data-attachment-id={images[0]?.attachmentId}
    />
  ),
}))

jest.mock('@/hooks/useAttachmentImage', () => ({
  useAttachmentImage: () => ({
    blobUrl: 'blob:generated-image',
    isLoading: false,
    error: false,
  }),
}))

const makeAttachmentContext = (
  id: number,
  name: string,
  fileExtension: string
): SubtaskContextBrief =>
  ({
    id,
    name,
    context_type: 'attachment',
    file_extension: fileExtension,
    file_size: 1024,
    mime_type: 'application/octet-stream',
    status: 'ready',
  }) as SubtaskContextBrief

describe('ContextBadgeList', () => {
  it('renders image attachments as compact thumbnails', () => {
    render(
      <ContextBadgeList
        contexts={[
          makeAttachmentContext(1, 'reference.png', '.png'),
          makeAttachmentContext(2, 'document.pdf', '.pdf'),
        ]}
      />
    )

    expect(screen.getByTestId('attachment-reference.png')).toHaveAttribute('data-compact', 'true')
    expect(screen.getByTestId('attachment-document.pdf')).toHaveAttribute('data-compact', 'false')
  })

  it('renders assistant image contexts with the generated image gallery', () => {
    render(
      <ContextBadgeList
        contexts={[makeAttachmentContext(40, 'image_179_250_0.png', '.png')]}
        displayGeneratedMedia
      />
    )

    expect(screen.getByTestId('generated-image-gallery')).toHaveAttribute(
      'data-url',
      'blob:generated-image'
    )
    expect(screen.getByTestId('generated-image-gallery')).toHaveAttribute(
      'data-attachment-id',
      '40'
    )
    expect(screen.queryByTestId('attachment-image_179_250_0.png')).not.toBeInTheDocument()
  })
})
