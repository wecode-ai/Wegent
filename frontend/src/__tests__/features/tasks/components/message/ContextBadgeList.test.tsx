// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ContextBadgeList } from '@/features/tasks/components/message/ContextBadgeList'
import type { SubtaskContextBrief } from '@/types/api'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

jest.mock('@/features/tasks/components/input/AttachmentPreview', () => ({
  __esModule: true,
  default: ({ attachment, compact }: { attachment: { filename: string }; compact: boolean }) => (
    <div data-testid={`attachment-${attachment.filename}`} data-compact={String(compact)} />
  ),
}))

jest.mock('@/features/tasks/components/message/ImageGallery', () => ({
  __esModule: true,
  default: ({ images }: { images: Array<{ url: string; attachmentId?: number }> }) => (
    <div
      data-testid="generated-image-gallery"
      data-url={images[0]?.url}
      data-attachment-id={images[0]?.attachmentId}
    />
  ),
}))

jest.mock('@/hooks/useAttachmentImage', () => ({
  useAttachmentImage: () => ({
    blobUrl: 'blob:generated-image',
    isLoading: false,
    error: false,
  }),
}))

jest.mock('@/apis/user', () => ({
  getToken: () => 'browser-token',
}))

const makeAttachmentContext = (
  id: number,
  name: string,
  fileExtension: string
): SubtaskContextBrief =>
  ({
    id,
    name,
    context_type: 'attachment',
    file_extension: fileExtension,
    file_size: 1024,
    mime_type: 'application/octet-stream',
    status: 'ready',
  }) as SubtaskContextBrief

describe('ContextBadgeList', () => {
  it('top-aligns mixed media so compact images do not stretch to video height', () => {
    const { container } = render(
      <ContextBadgeList
        contexts={[
          makeAttachmentContext(1, 'reference.mp4', '.mp4'),
          makeAttachmentContext(2, 'reference.png', '.png'),
        ]}
      />
    )

    expect(container.firstChild).toHaveClass('items-start')
  })

  it('renders sent media compactly and keeps documents full width', () => {
    render(
      <ContextBadgeList
        contexts={[
          makeAttachmentContext(1, 'reference.png', '.png'),
          makeAttachmentContext(2, 'document.pdf', '.pdf'),
        ]}
      />
    )

    expect(screen.getByTestId('attachment-reference.png')).toHaveAttribute('data-compact', 'true')
    expect(screen.getByTestId('attachment-document.pdf')).toHaveAttribute('data-compact', 'false')
  })

  it('renders assistant image contexts with the generated image gallery', () => {
    render(
      <ContextBadgeList
        contexts={[makeAttachmentContext(40, 'image_179_250_0.png', '.png')]}
        displayGeneratedMedia
      />
    )

    expect(screen.getByTestId('generated-image-gallery')).toHaveAttribute(
      'data-url',
      'blob:generated-image'
    )
    expect(screen.getByTestId('generated-image-gallery')).toHaveAttribute(
      'data-attachment-id',
      '40'
    )
    expect(screen.queryByTestId('attachment-image_179_250_0.png')).not.toBeInTheDocument()
  })

  it('downloads a declared device artifact through the authenticated backend route', async () => {
    const originalFetch = global.fetch
    const originalCreateObjectUrl = URL.createObjectURL
    const originalRevokeObjectUrl = URL.revokeObjectURL
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: jest.fn().mockResolvedValue(new Blob(['report'])),
    })
    global.fetch = fetchMock
    const createObjectUrl = jest.fn().mockReturnValue('blob:artifact')
    const revokeObjectUrl = jest.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
    const anchorClick = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)

    render(
      <ContextBadgeList
        contexts={[
          {
            id: 71,
            context_type: 'remote_workspace_artifact',
            name: 'report.pdf',
            status: 'ready',
            file_extension: '.pdf',
            file_size: 4096,
            mime_type: 'application/pdf',
            remote_task_id: 42,
            remote_path: 'outputs/report.pdf',
          },
        ]}
      />
    )

    fireEvent.click(screen.getByTestId('remote-workspace-artifact-download-71'))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/tasks/42/remote-workspace/artifacts/71/file?disposition=attachment',
        { headers: { Authorization: 'Bearer browser-token' } }
      )
    )
    expect(anchorClick).toHaveBeenCalled()
    expect(createObjectUrl).toHaveBeenCalled()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:artifact')

    global.fetch = originalFetch
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectUrl,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectUrl,
    })
    anchorClick.mockRestore()
  })

  it('renders a previous task reference without exposing its transcript', () => {
    render(
      <ContextBadgeList
        contexts={[
          {
            id: 91,
            context_type: 'conversation',
            name: 'Launch checklist',
            status: 'ready',
            task_id: 77,
          },
        ]}
      />
    )

    expect(screen.getByTestId('conversation-reference-77')).toBeInTheDocument()
    expect(screen.getByText('Launch checklist')).toBeInTheDocument()
  })
})
