// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { uploadFile } from '@/apis/attachments'
import { useMultiAttachment } from '@/hooks/useMultiAttachment'

let mockUser: { weibo_uid?: string | null } | null = { weibo_uid: '1234567890' }

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: mockUser,
    refresh: jest.fn(),
  }),
}))

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
    uploadFile: jest.fn(),
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
    mockUser = { weibo_uid: '1234567890' }
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    })
    jest.mocked(uploadFile).mockResolvedValue({
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

  it('uploads video immediately for a user with a Weibo binding', async () => {
    render(<UploadHarness />)

    fireEvent.click(screen.getByTestId('upload-video'))

    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('weibo-video-binding-prompt')).not.toBeInTheDocument()
    expect(screen.getByTestId('preview-url')).toHaveTextContent('blob:clip-video')

    await act(async () => {
      fireEvent.click(screen.getByTestId('remove-video'))
    })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:clip-video')
  })

  it('passes the video reference storage purpose to the upload API', async () => {
    mockUser = null
    render(<UploadHarness storagePurpose="video_reference" />)

    fireEvent.click(screen.getByTestId('upload-video'))

    await waitFor(() =>
      expect(uploadFile).toHaveBeenCalledWith(
        expect.any(File),
        expect.any(Function),
        undefined,
        'video_reference'
      )
    )
  })
})
