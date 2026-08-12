// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'

import { downloadAttachment } from '@/apis/attachments'
import { ImageGallery } from '@/features/tasks/components/message/ImageGallery'

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({
    fill: _fill,
    unoptimized: _unoptimized,
    alt,
    ...props
  }: React.ComponentProps<'img'> & { fill?: boolean; unoptimized?: boolean }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} {...props} />
  ),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

jest.mock('@/hooks/useAttachmentImage', () => ({
  useAttachmentImage: (attachmentId: number, enabled: boolean) => ({
    blobUrl: enabled ? `blob:attachment-${attachmentId}` : null,
    isLoading: false,
    error: false,
  }),
}))

jest.mock('@/apis/attachments', () => ({
  downloadAttachment: jest.fn(),
}))

describe('ImageGallery', () => {
  it('uses authenticated image access and keeps the merged action layout', () => {
    const onUseAsReference = jest.fn()
    const image = {
      url: '/api/attachments/12/download',
      attachmentId: 12,
    }
    render(
      <ImageGallery images={[image]} imageSize="1512x648" onUseAsReference={onUseAsReference} />
    )

    const thumbnail = screen.getByAltText('Generated image 1')
    expect(thumbnail).toHaveAttribute('src', 'blob:attachment-12')

    const download = screen.getByTestId('generated-image-download-0')
    const reference = screen.getByTestId('generated-image-reference-0')
    expect(download.parentElement).toHaveClass('absolute', 'top-2', 'right-2')
    expect(reference.nextElementSibling).toBe(download)
    expect(screen.queryByTitle('View full size')).not.toBeInTheDocument()

    const preview = screen.getByTestId('generated-image-preview-0')
    expect(preview.style.aspectRatio).toBe('1512 / 648')
    expect(preview.style.width).toBe('513.33px')
    expect(preview.style.height).toBe('220px')

    fireEvent.click(reference)
    expect(onUseAsReference).toHaveBeenCalledWith(image)
    expect(screen.queryByTestId('generated-image-lightbox')).not.toBeInTheDocument()
  })

  it('downloads attachments through the authenticated download API', () => {
    render(<ImageGallery images={[{ url: '/api/attachments/12/download', attachmentId: 12 }]} />)

    fireEvent.click(screen.getByTestId('generated-image-download-0'))

    expect(downloadAttachment).toHaveBeenCalledWith(12, 'generated_image_1.jpg', undefined)
  })

  it('renders authenticated lightbox images in document.body and restores scrolling', () => {
    const { container } = render(
      <div style={{ transform: 'translateZ(0)' }}>
        <ImageGallery images={[{ url: '/api/attachments/12/download', attachmentId: 12 }]} />
      </div>
    )

    fireEvent.click(screen.getByAltText('Generated image 1'))

    const lightbox = screen.getByTestId('generated-image-lightbox')
    expect(lightbox.parentElement).toBe(document.body)
    expect(container).not.toContainElement(lightbox)
    expect(document.body).toHaveStyle({ overflow: 'hidden' })

    const previews = screen.getAllByAltText('Generated image 1')
    expect(previews).toHaveLength(2)
    expect(previews[1]).toHaveAttribute('src', 'blob:attachment-12')

    fireEvent.click(screen.getByTitle('Close'))

    expect(screen.queryByTestId('generated-image-lightbox')).not.toBeInTheDocument()
    expect(document.body.style.overflow).toBe('')
  })

  it('uses the loaded image dimensions when block metadata has no image size', () => {
    render(<ImageGallery images={[{ url: '/generated-wide.png' }]} />)

    const image = screen.getByAltText('Generated image 1')
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 2016 },
      naturalHeight: { configurable: true, value: 864 },
    })
    fireEvent.load(image)

    const preview = screen.getByTestId('generated-image-preview-0')
    expect(preview.style.aspectRatio).toBe('2016 / 864')
    expect(preview.style.width).toBe('513.33px')
    expect(preview.style.height).toBe('220px')
  })
})
