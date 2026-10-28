// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DocumentLinkPreview } from '@/features/knowledge/document/components/DocumentLinkPreview'
import { DocumentLinkResource } from '@/features/knowledge/document/components/DocumentLinkResource'
import {
  createDocumentLinkResource,
  type DocumentLinkResource as Resource,
} from '@/features/knowledge/document/utils/documentLinkResource'
import { loadBoundedRemoteFile } from '@/features/knowledge/document/utils/boundedRemoteFile'

const mockOfficePreview = jest.fn(
  ({ blob, url }: { blob?: Blob; url?: string; onError?: (error: Error) => void }) => (
    <div data-testid="mock-office-cover">{blob ? 'blob-ready' : url || 'missing-source'}</div>
  )
)

jest.mock('@/components/common/FilePreview/preview-renderers/FlyfishOfficePreview', () => ({
  FlyfishOfficePreview: (props: Parameters<typeof mockOfficePreview>[0]) =>
    mockOfficePreview(props),
}))

jest.mock('@/features/knowledge/document/utils/boundedRemoteFile', () => ({
  loadBoundedRemoteFile: jest.fn().mockResolvedValue({
    blob: Object.assign(new Blob(['office']), {
      text: jest.fn().mockResolvedValue('# Preview content'),
    }),
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 6,
  }),
  prepareRemotePdf: jest.fn().mockResolvedValue({
    mimeType: 'application/pdf',
    size: 36 * 1024 * 1024,
    supportsRange: true,
  }),
  probeRemoteVideo: jest.fn().mockResolvedValue({ size: 1024, supportsRange: true }),
  RemoteFileError: class RemoteFileError extends Error {},
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === 'document.document.detail.linkPreview.viewOnline' ? '点击查看在线预览' : key,
  }),
}))

const pdfResource: Resource = {
  key: '1149:https://cdn.example.com/large.pdf',
  documentId: 1149,
  url: 'https://cdn.example.com/large.pdf',
  label: 'large.pdf',
  filename: 'large.pdf',
  kindHint: 'pdf',
}

const officeResource: Resource = {
  key: '1149:https://cdn.example.com/report.docx',
  documentId: 1149,
  url: 'https://cdn.example.com/report.docx',
  label: 'report.docx',
  filename: 'report.docx',
  kindHint: 'office',
}

const imageResource: Resource = {
  ...officeResource,
  key: '1149:https://cdn.example.com/image.png',
  url: 'https://cdn.example.com/image.png',
  label: 'image.png',
  filename: 'image.png',
  kindHint: 'image',
}

const textResource: Resource = {
  ...officeResource,
  key: '1149:https://cdn.example.com/readme.md',
  url: 'https://cdn.example.com/readme.md',
  label: 'readme.md',
  filename: 'readme.md',
  kindHint: 'text',
}

describe('signed resource expiry', () => {
  it('reads the OSS v4 expiry for preview error reporting', () => {
    expect(
      createDocumentLinkResource(
        1149,
        'https://cdn.example.com/file.pdf?x-oss-date=20200101T000000Z&x-oss-expires=3600'
      )?.expiresAt
    ).toBe(Date.UTC(2020, 0, 1, 1))
  })
})

describe('DocumentLinkResource', () => {
  beforeAll(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: jest.fn().mockReturnValue('blob:https://localhost/image-cover'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: jest.fn(),
    })
  })

  it('renders a PDF first-page card and opens the online preview', async () => {
    const onOpen = jest.fn()
    render(<DocumentLinkResource resource={pdfResource} onOpen={onOpen} />)

    expect(screen.getByTestId('document-link-preview-card')).toBeInTheDocument()
    expect(await screen.findByTestId('mock-office-cover')).toHaveTextContent(pdfResource.url)
    expect(screen.queryByTestId('remote-pdf-preview')).not.toBeInTheDocument()
    expect(screen.getByText('点击查看在线预览')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('document-link-preview-trigger'))
    expect(onOpen).toHaveBeenCalledWith(pdfResource)
  })

  it('renders an Office first-page card instead of a compact link button', async () => {
    render(<DocumentLinkResource resource={officeResource} onOpen={jest.fn()} />)

    expect(screen.getByTestId('document-link-preview-card')).toBeInTheDocument()
    expect(await screen.findByTestId('mock-office-cover')).toHaveTextContent('blob-ready')
    expect(screen.getByText('点击查看在线预览')).toBeInTheDocument()
  })

  it('renders bounded image and text links as preview cards', async () => {
    const { rerender } = render(
      <DocumentLinkResource resource={imageResource} onOpen={jest.fn()} />
    )
    expect(await screen.findByTestId('document-link-image-cover')).toHaveAttribute(
      'src',
      'blob:https://localhost/image-cover'
    )

    rerender(<DocumentLinkResource resource={textResource} onOpen={jest.fn()} />)
    expect(await screen.findByText('# Preview content')).toBeInTheDocument()
    expect(screen.getByTestId('document-link-preview-card')).toBeInTheDocument()
  })

  it('does not allocate an image object URL after its cover has unmounted', async () => {
    let resolveLoad: ((value: { blob: Blob; mimeType: string; size: number }) => void) | undefined
    jest.mocked(loadBoundedRemoteFile).mockReturnValueOnce(
      new Promise(resolve => {
        resolveLoad = resolve
      })
    )
    const createObjectUrl = jest.mocked(URL.createObjectURL)
    createObjectUrl.mockClear()
    const { unmount } = render(<DocumentLinkResource resource={imageResource} onOpen={jest.fn()} />)
    await waitFor(() => expect(loadBoundedRemoteFile).toHaveBeenCalled())

    unmount()
    await act(async () => {
      resolveLoad!({ blob: new Blob(['image']), mimeType: 'image/png', size: 5 })
      await Promise.resolve()
    })

    expect(createObjectUrl).not.toHaveBeenCalled()
  })

  it('uses the shared PDF renderer instead of an Edge-blocked iframe', async () => {
    render(<DocumentLinkPreview resource={pdfResource} onOpenChange={jest.fn()} />)

    expect(await screen.findByTestId('mock-office-cover')).toHaveTextContent(pdfResource.url)
    expect(screen.queryByTestId('remote-pdf-preview')).not.toBeInTheDocument()
  })

  it('does not misreport a PDF renderer failure as a damaged file and allows retry', async () => {
    render(<DocumentLinkPreview resource={pdfResource} onOpenChange={jest.fn()} />)
    await screen.findByTestId('mock-office-cover')

    act(() => {
      mockOfficePreview.mock.calls.at(-1)![0].onError!(
        new TypeError('Object.defineProperty called on non-object')
      )
    })

    expect(
      screen.getByText('document.document.detail.linkPreview.errors.preview-failed')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('document.document.detail.linkPreview.errors.parse-failed')
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('document-link-preview-retry'))
    expect(await screen.findByTestId('mock-office-cover')).toHaveTextContent(pdfResource.url)
  })

  it('preserves the existing Office parse-error behavior', async () => {
    render(<DocumentLinkPreview resource={officeResource} onOpenChange={jest.fn()} />)
    await screen.findByTestId('mock-office-cover')

    act(() => {
      mockOfficePreview.mock.calls.at(-1)![0].onError!(new Error('Invalid Office archive'))
    })

    expect(
      screen.getByText('document.document.detail.linkPreview.errors.parse-failed')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('document-link-preview-retry')).not.toBeInTheDocument()
  })
})
