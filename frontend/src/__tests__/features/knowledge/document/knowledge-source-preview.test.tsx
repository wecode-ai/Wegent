// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KnowledgeSourcePreview } from '@/features/knowledge/document/components/KnowledgeSourcePreview'
import { KNOWLEDGE_SOURCE_PREVIEW_MAX_BYTES } from '@/features/knowledge/document/utils/sourcePreview'
import type { KnowledgeDocument } from '@/types/knowledge'
import { downloadAttachment, fetchAttachmentFile } from '@/apis/attachments'
import { toast } from 'sonner'

jest.mock('@/components/common/FilePreview', () => ({
  FilePreview: ({ fileBlob }: { fileBlob: File }) => (
    <div data-testid="mock-file-preview">{fileBlob.name}</div>
  ),
}))

jest.mock('@/apis/attachments', () => ({
  downloadAttachment: jest.fn(),
  fetchAttachmentFile: jest.fn(),
  formatFileSize: (bytes: number) => `${bytes} B`,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('sonner', () => ({
  toast: {
    error: jest.fn(),
  },
}))

const document: KnowledgeDocument = {
  id: 1,
  kind_id: 2,
  attachment_id: 3,
  name: 'report.docx',
  file_extension: 'docx',
  file_size: 1024,
  status: 'enabled',
  user_id: 1,
  is_active: true,
  index_status: 'success',
  index_generation: 1,
  source_type: 'file',
  source_config: {},
  folder_id: 0,
  created_at: '2026-07-15T00:00:00Z',
  updated_at: '2026-07-15T00:00:00Z',
}

describe('KnowledgeSourcePreview', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(fetchAttachmentFile as jest.Mock).mockResolvedValue(
      new File(['office'], 'report.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
    )
  })

  it('does not fetch the source file before the view becomes active', () => {
    render(
      <KnowledgeSourcePreview
        document={document}
        active={false}
        isFullscreen={false}
        onFullscreenChange={jest.fn()}
      />
    )

    expect(fetchAttachmentFile).not.toHaveBeenCalled()
  })

  it('fetches and renders the original file after activation', async () => {
    render(
      <KnowledgeSourcePreview
        document={document}
        active={true}
        isFullscreen={false}
        onFullscreenChange={jest.fn()}
      />
    )

    await waitFor(() => expect(screen.getByTestId('mock-file-preview')).toBeInTheDocument())
    expect(fetchAttachmentFile).toHaveBeenCalledWith(3, {
      filename: 'report.docx',
      signal: expect.any(AbortSignal),
    })
  })

  it('aborts an in-flight request when the preview is deactivated', () => {
    ;(fetchAttachmentFile as jest.Mock).mockReturnValue(new Promise(() => undefined))
    const { rerender } = render(
      <KnowledgeSourcePreview
        document={document}
        active={true}
        isFullscreen={false}
        onFullscreenChange={jest.fn()}
      />
    )
    const signal = (fetchAttachmentFile as jest.Mock).mock.calls[0][1].signal as AbortSignal

    act(() => {
      rerender(
        <KnowledgeSourcePreview
          document={document}
          active={false}
          isFullscreen={false}
          onFullscreenChange={jest.fn()}
        />
      )
    })

    expect(signal.aborted).toBe(true)
  })

  it('does not fetch files above the preview limit and keeps download available', async () => {
    render(
      <KnowledgeSourcePreview
        document={{
          ...document,
          file_size: KNOWLEDGE_SOURCE_PREVIEW_MAX_BYTES + 1,
        }}
        active={true}
        isFullscreen={false}
        onFullscreenChange={jest.fn()}
      />
    )

    expect(fetchAttachmentFile).not.toHaveBeenCalled()
    screen.getByTestId('knowledge-source-preview-too-large-download').click()
    await waitFor(() => expect(downloadAttachment).toHaveBeenCalledWith(3, 'report.docx'))
  })

  it('can retry after loading the original file fails', async () => {
    const user = userEvent.setup()
    ;(fetchAttachmentFile as jest.Mock)
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(new File(['office'], 'report.docx'))

    render(
      <KnowledgeSourcePreview
        document={document}
        active={true}
        isFullscreen={false}
        onFullscreenChange={jest.fn()}
      />
    )

    await user.click(await screen.findByTestId('knowledge-source-preview-retry'))

    await waitFor(() => expect(screen.getByTestId('mock-file-preview')).toBeInTheDocument())
    expect(fetchAttachmentFile).toHaveBeenCalledTimes(2)
  })

  it('keeps a rendered preview visible when downloading fails', async () => {
    const user = userEvent.setup()
    ;(downloadAttachment as jest.Mock).mockRejectedValue(new Error('download failed'))

    render(
      <KnowledgeSourcePreview
        document={document}
        active={true}
        isFullscreen={false}
        onFullscreenChange={jest.fn()}
      />
    )

    await screen.findByTestId('mock-file-preview')
    await user.click(screen.getByTestId('knowledge-source-preview-download'))

    expect(toast.error).toHaveBeenCalledWith(
      'document.document.detail.sourcePreview.downloadFailed'
    )
    expect(screen.getByTestId('mock-file-preview')).toBeInTheDocument()
  })
})
