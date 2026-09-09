// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@testing-library/react'

import { getAttachmentPlayback } from '@/apis/attachments'
import { MultimodalImagePreview } from '@/features/knowledge/multimodal/components/MultimodalImagePreview'

const PLAYBACK_URL = '/api/attachments/7/download?download_token=playback-token'

jest.mock('@/apis/attachments', () => {
  const actual = jest.requireActual('@/apis/attachments')
  const getAttachmentPlayback = jest.fn()
  return {
    __esModule: true,
    ...actual,
    getAttachmentPlayback,
  }
})

const mockGetAttachmentPlayback = jest.mocked(getAttachmentPlayback)

describe('MultimodalImagePreview', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    URL.createObjectURL = jest.fn(() => 'blob:preview')
    URL.revokeObjectURL = jest.fn()
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['image-bytes'], { type: 'image/png' })),
    })
    mockGetAttachmentPlayback.mockResolvedValue({ playback_url: PLAYBACK_URL })
  })

  it('loads the image through the playback exit so protected KBs keep previewing', async () => {
    render(<MultimodalImagePreview attachmentId={7} alt="report.png" />)

    await waitFor(() => {
      expect(screen.getByTestId('multimodal-image-preview')).toBeInTheDocument()
    })

    expect(mockGetAttachmentPlayback).toHaveBeenCalledWith(7)
    expect(global.fetch).toHaveBeenCalledWith(PLAYBACK_URL)
    expect(URL.createObjectURL).toHaveBeenCalled()
  })

  it('shows the fallback when playback resolution fails', async () => {
    mockGetAttachmentPlayback.mockRejectedValue(new Error('403'))

    render(<MultimodalImagePreview attachmentId={7} alt="report.png" />)

    await waitFor(() => {
      expect(screen.getByText('report.png')).toBeInTheDocument()
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
