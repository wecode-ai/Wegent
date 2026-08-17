// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen } from '@testing-library/react'

import { AttachmentPreviewInline } from '@/features/tasks/components/input/InputBadgeDisplay'
import type { Attachment } from '@/types/api'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const videoAttachment: Attachment = {
  id: 42,
  filename: 'reference.mp4',
  file_size: 1024,
  mime_type: 'video/mp4',
  status: 'ready',
  file_extension: '.mp4',
  created_at: '2026-08-12T00:00:00.000Z',
  local_preview_url: 'blob:reference-video',
}

describe('AttachmentPreviewInline media playback', () => {
  const play = jest.fn().mockResolvedValue(undefined)
  const pause = jest.fn()

  beforeEach(() => {
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: play,
    })
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value: pause,
    })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('plays on hover and opens the video player dialog on click', async () => {
    render(
      <AttachmentPreviewInline attachment={videoAttachment} onRemove={jest.fn()} t={key => key} />
    )

    const preview = screen.getByTestId('attachment-media-preview-42')
    expect(preview).toHaveClass('h-14', 'w-14')

    await act(async () => {
      fireEvent.mouseEnter(preview)
      await Promise.resolve()
    })
    expect(play).toHaveBeenCalledTimes(1)
    expect(preview).toHaveClass('h-24', 'w-40')

    fireEvent.click(preview)
    expect(pause).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('attachment-video-dialog-42')).toBeInTheDocument()

    fireEvent.mouseLeave(preview)
    expect(pause).toHaveBeenCalledTimes(2)
    expect(preview).toHaveClass('h-14', 'w-14')
  })

  it('stops playback before removing the attachment', () => {
    const onRemove = jest.fn()
    render(
      <AttachmentPreviewInline attachment={videoAttachment} onRemove={onRemove} t={key => key} />
    )

    fireEvent.click(screen.getByTestId('remove-attachment-42'))

    expect(pause).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})
