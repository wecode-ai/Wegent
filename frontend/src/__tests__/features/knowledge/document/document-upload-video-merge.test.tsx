// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { uploadAttachment } from '@/apis/attachments'
import { DocumentUpload } from '@/features/knowledge/document/components/DocumentUpload'
import { loadKBExtensions } from '@/features/knowledge/document/extension-loader'
import { readLocalVideoDuration } from '@/features/knowledge/multimodal/utils/video-duration'
import { registerVideoUploader } from '@/features/knowledge/multimodal/video-upload-registry'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('@/apis/attachments', () => ({
  ...jest.requireActual('@/apis/attachments'),
  uploadAttachment: jest.fn(),
  deleteAttachment: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/features/knowledge/document/extension-loader', () => ({
  loadKBExtensions: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/features/knowledge/multimodal/hooks/useMultimodalFeatureEnabled', () => ({
  useMultimodalFeatureEnabled: () => true,
}))
jest.mock('@/features/knowledge/multimodal/utils/video-duration', () => ({
  ...jest.requireActual('@/features/knowledge/multimodal/utils/video-duration'),
  readLocalVideoDuration: jest.fn(),
}))
jest.mock('@/features/knowledge/document/components/SplitterSettingsSection', () => ({
  SplitterSettingsSection: () => null,
}))
jest.mock('@/features/knowledge/multimodal/components/MultimodalPromptEditor', () => ({
  MultimodalPromptEditor: () => null,
}))

describe('DocumentUpload merged video and source workflows', () => {
  const createDocuments = jest.fn()
  const uploadVideo = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    registerVideoUploader(null)
    uploadVideo.mockResolvedValue({ attachment_id: 101 })
    jest.mocked(loadKBExtensions).mockImplementation(async () => {
      registerVideoUploader({ upload: uploadVideo, maxSizeBytes: 1024 * 1024 })
    })
    jest.mocked(readLocalVideoDuration).mockResolvedValue(60)
    jest.mocked(uploadAttachment).mockImplementation(async file => ({
      id: 101,
      filename: file.name,
      file_size: file.size,
      mime_type: file.type,
      status: 'ready',
    }))
    createDocuments.mockResolvedValue([{ attachmentId: 101, documentId: 201 }])
  })

  afterEach(() => registerVideoUploader(null))

  function mount(multimodalVideoPrompt?: string) {
    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <DocumentUpload
          knowledgeBaseId={42}
          open={open}
          onOpenChange={setOpen}
          onUploadComplete={createDocuments}
          multimodalAnalysisEnabled
          multimodalVideoPrompt={multimodalVideoPrompt}
        />
      )
    }
    render(<Harness />)
  }

  function selectVideo() {
    fireEvent.change(screen.getByTestId('document-upload-file-input'), {
      target: { files: [new File(['video'], 'recording.mp4', { type: 'video/mp4' })] },
    })
  }

  function addTextDraft() {
    fireEvent.click(screen.getByTestId('document-source-text'))
    fireEvent.change(screen.getByTestId('document-text-content'), {
      target: { value: 'Keep this draft' },
    })
    fireEvent.click(screen.getByTestId('document-source-file'))
  }

  it('initializes internal upload extensions and cancels long videos before uploading', async () => {
    jest.mocked(readLocalVideoDuration).mockResolvedValue(1801)
    mount()
    selectVideo()
    fireEvent.click(await screen.findByTestId('long-video-warning-cancel'))

    expect(loadKBExtensions).toHaveBeenCalled()
    expect(uploadAttachment).not.toHaveBeenCalled()
    expect(uploadVideo).not.toHaveBeenCalled()
    expect(createDocuments).not.toHaveBeenCalled()
    expect(screen.getByTestId('document-upload-submit')).toBeDisabled()
  })

  it('uploads a confirmed long video while preserving another source draft', async () => {
    jest.mocked(readLocalVideoDuration).mockResolvedValue(1801)
    mount()
    addTextDraft()
    selectVideo()
    fireEvent.click(await screen.findByTestId('long-video-warning-continue'))
    await waitFor(() => expect(screen.getByTestId('document-upload-submit')).toBeEnabled())
    fireEvent.click(screen.getByTestId('document-upload-submit'))

    await screen.findByTestId('document-upload-notice')
    expect(uploadVideo).toHaveBeenCalledTimes(1)
    expect(uploadAttachment).not.toHaveBeenCalled()
    expect(createDocuments).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('document-source-text'))
    expect(screen.getByTestId('document-text-content')).toHaveValue('Keep this draft')
  })

  it('allows cancelling timestamp review then injecting the contract without losing drafts', async () => {
    mount('Summarize the recording')
    addTextDraft()
    selectVideo()
    await waitFor(() => expect(screen.getByTestId('document-upload-submit')).toBeEnabled())
    fireEvent.click(screen.getByTestId('document-upload-submit'))
    fireEvent.click(await screen.findByTestId('video-timestamp-prompt-return'))
    expect(createDocuments).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('document-upload-submit'))
    fireEvent.click(await screen.findByTestId('video-timestamp-prompt-inject'))
    await screen.findByTestId('document-upload-notice')
    expect(createDocuments).toHaveBeenCalledTimes(1)
    expect(createDocuments.mock.calls[0][2].video).toContain('Summarize the recording')
    expect(createDocuments.mock.calls[0][2].video).not.toBe('Summarize the recording')
    fireEvent.click(screen.getByTestId('document-source-text'))
    expect(screen.getByTestId('document-text-content')).toHaveValue('Keep this draft')
  })
})
