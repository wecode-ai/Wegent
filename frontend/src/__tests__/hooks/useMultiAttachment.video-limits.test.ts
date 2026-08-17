// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'
import { uploadAttachment } from '@/apis/attachments'
import { useMultiAttachment } from '@/hooks/useMultiAttachment'
import { toast } from '@/hooks/use-toast'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/hooks/use-toast', () => ({
  toast: jest.fn(),
}))

jest.mock('@/apis/attachments', () => ({
  uploadAttachment: jest.fn(),
  deleteAttachment: jest.fn(),
  isSupportedExtension: jest.fn(() => true),
  isValidFileSize: jest.fn(() => true),
  MAX_FILE_SIZE: 100 * 1024 * 1024,
  getErrorMessageFromCode: jest.fn(() => null),
  getFileExtension: jest.fn((filename: string) => filename.slice(filename.lastIndexOf('.'))),
  isImageExtension: jest.fn((extension: string) =>
    ['.jpg', '.jpeg', '.png', '.webp'].includes(extension)
  ),
  isVideoExtension: jest.fn((extension: string) => ['.mp4', '.mov'].includes(extension)),
  isAudioExtension: jest.fn((extension: string) => ['.mp3', '.m4a'].includes(extension)),
}))

function createUploadResult(file: File, id: number) {
  return {
    id,
    filename: file.name,
    file_size: file.size,
    mime_type: file.type,
    status: 'ready' as const,
    text_length: null,
    error_message: null,
    error_code: null,
    truncation_info: null,
    pic_id: null,
    image_url: null,
    media_id: null,
  }
}

describe('useMultiAttachment video material limits', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('enforces a per-type limit across files selected in the same batch', async () => {
    const mockedUpload = uploadAttachment as jest.MockedFunction<typeof uploadAttachment>
    mockedUpload.mockImplementation(async file => createUploadResult(file, 1))
    const { result } = renderHook(() =>
      useMultiAttachment({
        maxAttachments: 3,
        maxByType: { image: 1 },
      })
    )

    await act(async () => {
      await result.current.handleFileSelect([
        new File(['first'], 'first.png', { type: 'image/png' }),
        new File(['second'], 'second.png', { type: 'image/png' }),
      ])
    })

    expect(mockedUpload).toHaveBeenCalledTimes(1)
    expect(result.current.state.attachments).toHaveLength(1)
    expect(result.current.state.errors.size).toBe(0)
    expect(toast).toHaveBeenCalledWith({
      title: 'chat:generate.max_material_type',
      variant: 'destructive',
    })
  })

  it('rejects the whole batch and shows the model limit before uploading', async () => {
    const files = Array.from(
      { length: 17 },
      (_, index) => new File([String(index)], `reference-${index}.png`, { type: 'image/png' })
    )
    const { result } = renderHook(() => useMultiAttachment({ maxAttachments: 16 }))

    await act(async () => {
      await result.current.handleFileSelect(files)
    })

    expect(uploadAttachment).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith({
      title: 'chat:generate.attachment_limit_reached',
      description: 'chat:generate.max_attachments',
      variant: 'default',
    })
  })

  it('shows an immediate error when model validation rejects a selected file', async () => {
    const validateFile = jest.fn(async () => 'chat:generate.material_errors.mode_image_only')
    const { result } = renderHook(() => useMultiAttachment({ validateFile }))

    await act(async () => {
      await result.current.handleFileSelect(
        new File(['video'], 'reference.mp4', { type: 'video/mp4' })
      )
    })

    expect(uploadAttachment).not.toHaveBeenCalled()
    expect(result.current.state.errors.size).toBe(0)
    expect(toast).toHaveBeenCalledWith({
      title: 'chat:generate.material_errors.mode_image_only',
      variant: 'destructive',
    })
  })

  it('rejects a video when existing images exceed the image-with-video limit', async () => {
    const mockedUpload = uploadAttachment as jest.MockedFunction<typeof uploadAttachment>
    let uploadId = 0
    mockedUpload.mockImplementation(async file => createUploadResult(file, ++uploadId))
    const { result } = renderHook(() =>
      useMultiAttachment({
        maxAttachments: 5,
        maxByType: { image: 3, imageWithVideo: 1, video: 1 },
      })
    )

    await act(async () => {
      await result.current.handleFileSelect([
        new File(['first'], 'first.png', { type: 'image/png' }),
        new File(['second'], 'second.png', { type: 'image/png' }),
        new File(['video'], 'reference.mp4', { type: 'video/mp4' }),
      ])
    })

    expect(mockedUpload).toHaveBeenCalledTimes(2)
    expect(result.current.state.errors.size).toBe(0)
    expect(toast).toHaveBeenCalledWith({
      title: 'chat:generate.max_material_type',
      variant: 'destructive',
    })
  })

  it('uses the image-with-video limit after a video in the same batch', async () => {
    const mockedUpload = uploadAttachment as jest.MockedFunction<typeof uploadAttachment>
    let uploadId = 0
    mockedUpload.mockImplementation(async file => createUploadResult(file, ++uploadId))
    const { result } = renderHook(() =>
      useMultiAttachment({
        maxAttachments: 5,
        maxByType: { image: 3, imageWithVideo: 1, video: 1 },
      })
    )

    await act(async () => {
      await result.current.handleFileSelect([
        new File(['video'], 'reference.mp4', { type: 'video/mp4' }),
        new File(['first'], 'first.png', { type: 'image/png' }),
        new File(['second'], 'second.png', { type: 'image/png' }),
      ])
    })

    expect(mockedUpload).toHaveBeenCalledTimes(2)
    expect(result.current.state.errors.size).toBe(0)
    expect(toast).toHaveBeenCalledWith({
      title: 'chat:generate.max_material_type',
      variant: 'destructive',
    })
  })
})
