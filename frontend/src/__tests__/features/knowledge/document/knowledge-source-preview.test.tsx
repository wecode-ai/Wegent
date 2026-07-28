// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { KnowledgeSourcePreview } from '@/features/knowledge/document/components/KnowledgeSourcePreview'
import { KNOWLEDGE_SOURCE_PREVIEW_MAX_BYTES } from '@/features/knowledge/document/utils/sourcePreview'
import type { KnowledgeDocument } from '@/types/knowledge'
import { fetchAttachmentFile } from '@/apis/attachments'

jest.mock('@/components/common/FilePreview', () => ({
  FilePreview: ({ fileBlob, onError }: { fileBlob: File; onError?: (error: Error) => void }) => (
    <div data-testid="mock-file-preview">
      {fileBlob.name}
      <button type="button" onClick={() => onError?.(new Error('render error'))}>
        fail render
      </button>
    </div>
  ),
}))

jest.mock('@/apis/attachments', () => ({
  fetchAttachmentFile: jest.fn(),
  formatFileSize: (bytes: number) => `${bytes} B`,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
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
  const onDownload = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    ;(fetchAttachmentFile as jest.Mock).mockResolvedValue(
      new File(['office'], 'report.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
    )
  })

  it('does not fetch the source file before the view becomes active', () => {
    render(<KnowledgeSourcePreview document={document} active={false} onDownload={onDownload} />)

    expect(fetchAttachmentFile).not.toHaveBeenCalled()
  })

  it('fetches and renders the original file after activation', async () => {
    render(<KnowledgeSourcePreview document={document} active={true} onDownload={onDownload} />)

    await waitFor(() => expect(screen.getByTestId('mock-file-preview')).toBeInTheDocument())
    expect(screen.queryByTestId('knowledge-source-preview-download')).not.toBeInTheDocument()
    expect(fetchAttachmentFile).toHaveBeenCalledWith(3, {
      filename: 'report.docx',
      signal: expect.any(AbortSignal),
    })
  })

  it('keeps the loaded file when the mounted preview is hidden', async () => {
    const { rerender } = render(
      <KnowledgeSourcePreview document={document} active={true} onDownload={onDownload} />
    )

    await waitFor(() => expect(screen.getByTestId('mock-file-preview')).toBeInTheDocument())

    rerender(
      <KnowledgeSourcePreview
        document={document}
        active={true}
        onDownload={onDownload}
        className="hidden"
      />
    )

    expect(screen.getByTestId('knowledge-source-preview')).toHaveClass('hidden')
    expect(screen.getByTestId('mock-file-preview')).toBeInTheDocument()
    expect(fetchAttachmentFile).toHaveBeenCalledTimes(1)
  })

  it('clears the loaded file when deactivated and fetches it again after reactivation', async () => {
    const { rerender } = render(
      <KnowledgeSourcePreview document={document} active={true} onDownload={onDownload} />
    )

    await waitFor(() => expect(screen.getByTestId('mock-file-preview')).toBeInTheDocument())

    rerender(<KnowledgeSourcePreview document={document} active={false} onDownload={onDownload} />)
    await waitFor(() => expect(screen.queryByTestId('mock-file-preview')).not.toBeInTheDocument())

    rerender(<KnowledgeSourcePreview document={document} active={true} onDownload={onDownload} />)
    await waitFor(() => expect(screen.getByTestId('mock-file-preview')).toBeInTheDocument())
    expect(fetchAttachmentFile).toHaveBeenCalledTimes(2)
  })

  it('aborts an in-flight request when the preview is deactivated', () => {
    ;(fetchAttachmentFile as jest.Mock).mockReturnValue(new Promise(() => undefined))
    const { rerender } = render(
      <KnowledgeSourcePreview document={document} active={true} onDownload={onDownload} />
    )
    const signal = (fetchAttachmentFile as jest.Mock).mock.calls[0][1].signal as AbortSignal

    act(() => {
      rerender(
        <KnowledgeSourcePreview document={document} active={false} onDownload={onDownload} />
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
        onDownload={onDownload}
      />
    )

    expect(fetchAttachmentFile).not.toHaveBeenCalled()
    const download = screen.getByTestId('knowledge-source-preview-too-large-download')
    expect(download).toHaveClass('max-md:min-h-[44px]', 'max-md:min-w-[44px]')
    download.click()
    await waitFor(() => expect(onDownload).toHaveBeenCalledTimes(1))
  })

  it('offers only retry after loading the original file fails', async () => {
    const user = userEvent.setup()
    ;(fetchAttachmentFile as jest.Mock)
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(new File(['office'], 'report.docx'))

    render(<KnowledgeSourcePreview document={document} active={true} onDownload={onDownload} />)

    const retry = await screen.findByTestId('knowledge-source-preview-fetch-retry')
    expect(retry).toHaveClass('max-md:min-h-[44px]', 'max-md:min-w-[44px]')
    expect(
      screen.getByText('document.document.detail.sourcePreview.fetchFailedTitle')
    ).toBeInTheDocument()
    expect(
      screen.getByText('document.document.detail.sourcePreview.fetchFailedDescription')
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('knowledge-source-preview-render-error-download')
    ).not.toBeInTheDocument()
    expect(onDownload).not.toHaveBeenCalled()
    await user.click(retry)

    await waitFor(() => expect(screen.getByTestId('mock-file-preview')).toBeInTheDocument())
    expect(fetchAttachmentFile).toHaveBeenCalledTimes(2)
  })

  it('retries a render failure without fetching the file again and keeps download available', async () => {
    const user = userEvent.setup()

    render(<KnowledgeSourcePreview document={document} active={true} onDownload={onDownload} />)

    await user.click(await screen.findByRole('button', { name: 'fail render' }))

    expect(
      screen.getByText('document.document.detail.sourcePreview.renderFailedTitle')
    ).toBeInTheDocument()
    expect(
      screen.getByText('document.document.detail.sourcePreview.renderFailedDescription')
    ).toBeInTheDocument()
    const retry = screen.getByTestId('knowledge-source-preview-render-retry')
    const download = screen.getByTestId('knowledge-source-preview-render-error-download')
    expect(retry).toHaveClass('max-md:min-h-[44px]', 'max-md:min-w-[44px]')
    expect(download).toHaveClass('max-md:min-h-[44px]', 'max-md:min-w-[44px]')
    await user.click(download)
    expect(onDownload).toHaveBeenCalledTimes(1)
    await user.click(retry)

    await waitFor(() => expect(screen.getByTestId('mock-file-preview')).toBeInTheDocument())
    expect(fetchAttachmentFile).toHaveBeenCalledTimes(1)
  })
})
