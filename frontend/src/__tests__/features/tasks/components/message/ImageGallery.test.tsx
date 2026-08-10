// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'

import { ImageGallery } from '@/features/tasks/components/message/ImageGallery'

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({
    fill: _fill,
    unoptimized: _unoptimized,
    ...props
  }: React.ComponentProps<'img'> & { fill?: boolean; unoptimized?: boolean }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img {...props} />
  ),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

describe('ImageGallery', () => {
  it('shows download and reference actions in the top-right without an expand action', () => {
    const onUseAsReference = jest.fn()
    render(
      <ImageGallery
        images={[{ url: '/generated.png', attachmentId: 12 }]}
        imageSize="1512x648"
        onUseAsReference={onUseAsReference}
      />
    )

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
    expect(onUseAsReference).toHaveBeenCalledWith({
      url: '/generated.png',
      attachmentId: 12,
    })
    expect(screen.queryByTestId('generated-image-lightbox')).not.toBeInTheDocument()
  })

  it('renders the lightbox in document.body and restores scrolling when closed', () => {
    const { container } = render(
      <div style={{ transform: 'translateZ(0)' }}>
        <ImageGallery images={[{ url: '/generated.png' }]} />
      </div>
    )

    fireEvent.click(screen.getByAltText('Generated image 1'))

    const lightbox = screen.getByTestId('generated-image-lightbox')
    expect(lightbox.parentElement).toBe(document.body)
    expect(container).not.toContainElement(lightbox)
    expect(document.body).toHaveStyle({ overflow: 'hidden' })

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
