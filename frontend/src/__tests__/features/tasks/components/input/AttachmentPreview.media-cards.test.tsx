// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { createAttachmentDownloadUrl } from '@/apis/attachments'
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
    createAttachmentDownloadUrl: jest.fn(),
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
    jest
      .mocked(createAttachmentDownloadUrl)
      .mockImplementation(async id => `https://backend.example.com/attachments/${id}`)
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

  it('renders video as a compact thumbnail and opens a player dialog', async () => {
    render(<AttachmentPreview attachment={attachment({})} />)

    await waitFor(() => expect(screen.getByTestId('sent-video-attachment-1')).toBeInTheDocument())
    const card = screen.getByTestId('sent-video-attachment-1')
    expect(card).toHaveClass('h-16', 'w-16')
    expect(screen.getByText('material.mp4')).toBeInTheDocument()

    fireEvent.click(card)
    expect(screen.getByTestId('sent-video-dialog-1')).toHaveAttribute(
      'src',
      'https://backend.example.com/attachments/1'
    )
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
