// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { getAttachmentPlayback } from '@/apis/attachments'
import AttachmentPreview from '@/features/tasks/components/input/AttachmentPreview'
import type { Attachment } from '@/types/api'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/hooks/useAttachmentImage', () => ({
  useAttachmentImage: () => ({
    blobUrl: 'blob:attachment-media',
    isLoading: false,
    error: false,
  }),
}))

jest.mock('@/apis/attachments', () => {
  const actual = jest.requireActual('@/apis/attachments')
  return {
    ...actual,
    getAttachmentPlayback: jest.fn(),
  }
})

const attachment = (overrides: Partial<Attachment>): Attachment => ({
  id: 1,
  filename: 'material.mp4',
  file_size: 1024,
  mime_type: 'video/mp4',
  status: 'ready',
  file_extension: '.mp4',
  created_at: '2026-08-12T00:00:00.000Z',
  ...overrides,
})

describe('AttachmentPreview sent media cards', () => {
  const play = jest.fn().mockResolvedValue(undefined)
  const pause = jest.fn()

  beforeEach(() => {
    jest.mocked(getAttachmentPlayback).mockImplementation(async id => ({
      playback_url: `https://backend.example.com/attachments/${id}`,
      cover_url: null,
    }))
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

  it('renders a fixed-size video card and opens the unified player on click', async () => {
    render(<AttachmentPreview attachment={attachment({})} compact />)

    await waitFor(() => {
      expect(getAttachmentPlayback).toHaveBeenCalledWith(1, undefined)
    })

    const card = screen.getByTestId('sent-video-card-1')
    expect(card).toHaveClass('h-14', 'w-14')
    expect(screen.getByTestId('sent-video-attachment-1')).toHaveAttribute(
      'src',
      'https://backend.example.com/attachments/1#t=0.001'
    )
    expect(screen.getByTestId('sent-video-attachment-1')).not.toHaveAttribute('controls')
    expect(screen.queryByText('material.mp4')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sent-video-dialog-1')).not.toBeInTheDocument()

    fireEvent.click(card)

    expect(await screen.findByTestId('generated-video-player')).toBeInTheDocument()
    expect(screen.getByTestId('video-toggle-overlay')).toBeInTheDocument()
    expect(screen.getByTestId('sent-video-dialog-1')).toHaveAttribute(
      'src',
      'https://backend.example.com/attachments/1#t=0.001'
    )
    expect(screen.getByRole('dialog', { name: 'material.mp4' })).toBeInTheDocument()
  })

  it('uses the resolved first-frame cover when available', async () => {
    jest.mocked(getAttachmentPlayback).mockResolvedValueOnce({
      playback_url: 'https://media.example.com/material.mp4',
      cover_url: 'https://media.example.com/material-cover.jpg',
    })

    render(<AttachmentPreview attachment={attachment({})} compact />)

    const video = await screen.findByTestId('sent-video-attachment-1')
    expect(video).toHaveAttribute('src', 'https://media.example.com/material.mp4')
    expect(video).toHaveAttribute('poster', 'https://media.example.com/material-cover.jpg')
  })

  it('replaces an unplayable compact video with the video fallback', async () => {
    render(<AttachmentPreview attachment={attachment({})} compact />)

    const video = await screen.findByTestId('sent-video-attachment-1')
    fireEvent.error(video)

    expect(screen.queryByTestId('sent-video-attachment-1')).not.toBeInTheDocument()
    expect(screen.getByLabelText('material.mp4')).toBeInTheDocument()
  })

  it('renders audio as a compact playable card', async () => {
    render(
      <AttachmentPreview
        attachment={attachment({
          id: 2,
          filename: 'material.mp3',
          mime_type: 'audio/mpeg',
          file_extension: '.mp3',
        })}
      />
    )

    await waitFor(() => expect(screen.getByTitle('actions.play')).toBeEnabled())
    expect(screen.getByTestId('sent-audio-attachment-2')).toHaveClass('h-12', 'max-w-52')
    expect(screen.queryByText('attachment.click_to_download')).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByTitle('actions.play'))
      await Promise.resolve()
    })
    expect(play).toHaveBeenCalledTimes(1)
  })
})
