// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { uploadAttachment } from '@/apis/attachments'
import { useMultiAttachment } from '@/hooks/useMultiAttachment'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  toast: jest.fn(),
}))

jest.mock('@/apis/attachments', () => {
  const actual = jest.requireActual('@/apis/attachments')
  return {
    ...actual,
    uploadAttachment: jest.fn(),
    deleteAttachment: jest.fn(),
  }
})

function UploadHarness({
  storagePurpose = 'default',
}: {
  storagePurpose?: 'default' | 'video_reference'
}) {
  const { handleFileSelect, handleRemove, state } = useMultiAttachment({ storagePurpose })
  return (
    <>
      <button
        type="button"
        data-testid="upload-video"
        onClick={() => handleFileSelect(new File(['video'], 'clip.mp4', { type: 'video/mp4' }))}
      >
        upload
      </button>
      <button
        type="button"
        data-testid="remove-video"
        onClick={() => state.attachments[0] && handleRemove(state.attachments[0].id)}
      >
        remove
      </button>
      <span data-testid="preview-url">{state.attachments[0]?.local_preview_url}</span>
    </>
  )
}

describe('useMultiAttachment video upload', () => {
  const createObjectURL = jest.fn(() => 'blob:clip-video')
  const revokeObjectURL = jest.fn()

  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    })
    jest.mocked(uploadAttachment).mockResolvedValue({
      id: 1,
      filename: 'clip.mp4',
      file_size: 5,
      mime_type: 'video/mp4',
      status: 'ready',
      text_length: 0,
      error_message: null,
      error_code: null,
      truncation_info: undefined,
    })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('uploads video immediately and creates a local preview', async () => {
    render(<UploadHarness />)

    fireEvent.click(screen.getByTestId('upload-video'))

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('preview-url')).toHaveTextContent('blob:clip-video')

    await act(async () => {
      fireEvent.click(screen.getByTestId('remove-video'))
    })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:clip-video')
  })

  it('passes the video reference storage purpose to the upload API', async () => {
    render(<UploadHarness storagePurpose="video_reference" />)

    fireEvent.click(screen.getByTestId('upload-video'))

    await waitFor(() =>
      expect(uploadAttachment).toHaveBeenCalledWith(
        expect.any(File),
        expect.any(Function),
        'video_reference'
      )
    )
  })
})
