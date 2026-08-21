// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { uploadFile } from '@/apis/attachments'
import { ApiError } from '@/apis/client'
import { userApis } from '@/apis/user'
import { useMultiAttachment } from '@/hooks/useMultiAttachment'

let mockUser: { weibo_uid?: string | null } | null = null
const mockRefresh = jest.fn()

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: mockUser,
    refresh: mockRefresh,
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

jest.mock('@/apis/user', () => ({
  userApis: {
    previewWeiboAccount: jest.fn(),
    bindWeiboAccount: jest.fn(),
  },
}))

jest.mock('@/apis/attachments', () => {
  const actual = jest.requireActual('@/apis/attachments')
  return {
    ...actual,
    uploadFile: jest.fn(),
    deleteAttachment: jest.fn(),
  }
})

function UploadHarness() {
  const { handleFileSelect, weiboBindingPrompt } = useMultiAttachment()
  return (
    <>
      <button
        type="button"
        data-testid="upload-video"
        onClick={() => handleFileSelect(new File(['video'], 'clip.mp4', { type: 'video/mp4' }))}
      >
        upload
      </button>
      {weiboBindingPrompt}
    </>
  )
}

describe('useMultiAttachment Weibo video binding prompt', () => {
  const mockedUserApis = jest.mocked(userApis)

  beforeEach(() => {
    mockUser = null
    mockRefresh.mockReset()
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

  it('prompts unbound users before video upload and continues only on request', async () => {
    render(<UploadHarness />)

    fireEvent.click(screen.getByTestId('upload-video'))

    expect(screen.getByTestId('weibo-video-binding-prompt')).toBeInTheDocument()
    expect(uploadFile).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('continue-video-upload-without-weibo-button'))

    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1))
  })

  it('uploads video immediately when the user already has a Weibo binding', async () => {
    mockUser = { weibo_uid: '1234567890' }

    render(<UploadHarness />)
    fireEvent.click(screen.getByTestId('upload-video'))

    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('weibo-video-binding-prompt')).not.toBeInTheDocument()
  })

  it('previews, confirms binding, refreshes user state, and uploads the pending video', async () => {
    mockedUserApis.previewWeiboAccount.mockResolvedValue({
      weibo_uid: '1234567890',
      weibo_screen_name: 'Bound User',
      weibo_avatar_url: null,
    })
    mockedUserApis.bindWeiboAccount.mockResolvedValue({
      bound: true,
      weibo_uid: '1234567890',
    })

    render(<UploadHarness />)
    fireEvent.click(screen.getByTestId('upload-video'))
    fireEvent.click(screen.getByTestId('preview-video-weibo-bind-button'))

    await waitFor(() => expect(screen.getByTestId('weibo-video-preview-uid')).toBeInTheDocument())
    expect(screen.getByTestId('weibo-video-preview-name')).toHaveTextContent('Bound User')

    fireEvent.click(screen.getByTestId('confirm-video-weibo-bind-button'))

    await waitFor(() => expect(mockedUserApis.bindWeiboAccount).toHaveBeenCalledWith('1234567890'))
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1))
  })

  it('resets preview account when binding detects a changed Weibo uid', async () => {
    mockedUserApis.previewWeiboAccount.mockResolvedValue({
      weibo_uid: '1234567890',
      weibo_screen_name: 'Bound User',
      weibo_avatar_url: null,
    })
    mockedUserApis.bindWeiboAccount.mockRejectedValue(
      new ApiError('changed', 409, 'weibo_uid_changed')
    )

    render(<UploadHarness />)
    fireEvent.click(screen.getByTestId('upload-video'))
    fireEvent.click(screen.getByTestId('preview-video-weibo-bind-button'))

    await waitFor(() => expect(screen.getByTestId('weibo-video-preview-uid')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('confirm-video-weibo-bind-button'))

    await waitFor(() => expect(mockedUserApis.bindWeiboAccount).toHaveBeenCalledWith('1234567890'))
    await waitFor(() =>
      expect(screen.queryByTestId('weibo-video-preview-uid')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('preview-video-weibo-bind-button')).toBeInTheDocument()
    expect(uploadFile).not.toHaveBeenCalled()
  })
})
