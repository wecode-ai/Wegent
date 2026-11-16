// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { DocumentLinkPreview } from '@/features/knowledge/document/components/DocumentLinkPreview'
import { DocumentLinkResource } from '@/features/knowledge/document/components/DocumentLinkResource'
import { DocumentProtectionBoundary } from '@/features/knowledge/document/components/DocumentProtectionBoundary'
import {
  createDocumentLinkResource,
  type DocumentLinkResource as Resource,
} from '@/features/knowledge/document/utils/documentLinkResource'
import {
  loadBoundedRemoteFile,
  prepareRemotePdf,
  probeRemoteVideo,
  RemoteFileError,
} from '@/features/knowledge/document/utils/boundedRemoteFile'

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
    validatedUrl: 'https://cdn.example.com/large.pdf',
  }),
  probeRemoteVideo: jest.fn().mockResolvedValue({
    size: 1024,
    supportsRange: true,
    validation: 'verified',
  }),
  RemoteFileError: class RemoteFileError extends Error {
    constructor(
      public readonly code: string,
      message: string
    ) {
      super(message)
    }
  },
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

const videoResource: Resource = {
  ...officeResource,
  key: '1149:https://cdn.example.com/video.mp4',
  url: 'https://cdn.example.com/video.mp4',
  label: 'video.mp4',
  filename: 'video.mp4',
  kindHint: 'video',
}

const previewProtectionProps = {
  knowledgeBaseId: 246,
  protectedPreview: false,
  isOrganization: false,
  watermarkText: 'reader 220750',
}

const resourceProtectionProps = {
  knowledgeBaseId: 246,
  coveredByDocumentWatermark: false,
  watermarkText: 'reader 220750',
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
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale: jest.fn(),
      translate: jest.fn(),
      rotate: jest.fn(),
      fillText: jest.fn(),
    } as unknown as CanvasRenderingContext2D)
    jest
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,watermark')
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: jest.fn().mockReturnValue('blob:https://localhost/image-cover'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: jest.fn(),
    })
  })

  beforeEach(() => {
    mockOfficePreview.mockClear()
    jest.mocked(prepareRemotePdf).mockClear()
    jest.mocked(loadBoundedRemoteFile).mockClear()
    jest.mocked(probeRemoteVideo).mockClear()
  })

  it('renders a PDF first-page card and opens the online preview', async () => {
    const onOpen = jest.fn()
    render(
      <DocumentLinkResource resource={pdfResource} onOpen={onOpen} {...resourceProtectionProps} />
    )

    expect(screen.getByTestId('document-link-preview-card')).toBeInTheDocument()
    expect(await screen.findByTestId('mock-office-cover')).toHaveTextContent(pdfResource.url)
    expect(prepareRemotePdf).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('remote-pdf-preview')).not.toBeInTheDocument()
    expect(screen.getByText('点击查看在线预览')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('document-link-preview-trigger'))
    expect(onOpen).toHaveBeenCalledWith(pdfResource)
  })

  it('renders an Office first-page card instead of a compact link button', async () => {
    render(
      <DocumentLinkResource
        resource={officeResource}
        onOpen={jest.fn()}
        {...resourceProtectionProps}
      />
    )

    expect(screen.getByTestId('document-link-preview-card')).toBeInTheDocument()
    expect(await screen.findByTestId('mock-office-cover')).toHaveTextContent('blob-ready')
    expect(loadBoundedRemoteFile).toHaveBeenCalledTimes(1)
    expect(screen.getByText('点击查看在线预览')).toBeInTheDocument()
  })

  it('adds one watermark to a cover that is not covered by document protection', async () => {
    render(
      <DocumentLinkResource
        resource={officeResource}
        onOpen={jest.fn()}
        {...resourceProtectionProps}
      />
    )

    expect(await screen.findByTestId('knowledge-watermarked-content')).toBeInTheDocument()
    expect(await screen.findByTestId('mock-office-cover')).toBeInTheDocument()
    expect(screen.getAllByTestId('knowledge-document-watermark')).toHaveLength(1)
  })

  it('keeps content hidden until a failed watermark generation is retried', async () => {
    jest.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementationOnce(() => {
      throw new Error('Canvas unavailable')
    })

    render(
      <DocumentProtectionBoundary
        enabled={false}
        showWatermark
        knowledgeBaseId={246}
        watermarkText="reader 220750"
      >
        <div data-testid="watermarked-file-content" />
      </DocumentProtectionBoundary>
    )

    expect(await screen.findByTestId('knowledge-watermark-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('watermarked-file-content')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('knowledge-watermark-retry'))
    const boundary = await screen.findByTestId('knowledge-watermarked-content')
    expect(screen.getByTestId('watermarked-file-content')).toBeInTheDocument()

    const copyEvent = new Event('copy', { cancelable: true, bubbles: true })
    boundary.dispatchEvent(copyEvent)
    expect(copyEvent.defaultPrevented).toBe(false)
  })

  it('does not add a second watermark when document protection covers the card', async () => {
    render(
      <DocumentLinkResource
        resource={officeResource}
        onOpen={jest.fn()}
        {...resourceProtectionProps}
        coveredByDocumentWatermark
      />
    )

    expect(await screen.findByTestId('mock-office-cover')).toBeInTheDocument()
    expect(screen.queryByTestId('knowledge-watermarked-content')).not.toBeInTheDocument()
    expect(screen.queryByTestId('knowledge-document-watermark')).not.toBeInTheDocument()
  })

  it('renders a video first-frame element after the bounded probe succeeds', async () => {
    render(
      <DocumentLinkResource
        resource={videoResource}
        onOpen={jest.fn()}
        {...resourceProtectionProps}
      />
    )

    expect(await screen.findByTestId('document-link-video-cover')).toHaveAttribute(
      'src',
      videoResource.url
    )
    expect(probeRemoteVideo).toHaveBeenCalledTimes(1)
  })

  it('keeps an offscreen card stable without loading or showing a loading state', () => {
    const originalObserver = global.IntersectionObserver
    const observe = jest.fn()
    Object.defineProperty(global, 'IntersectionObserver', {
      configurable: true,
      value: jest.fn(() => ({ observe, disconnect: jest.fn() })),
    })
    try {
      const { rerender } = render(
        <DocumentLinkResource
          resource={pdfResource}
          onOpen={jest.fn()}
          {...resourceProtectionProps}
        />
      )
      const card = screen.getByTestId('document-link-preview-card')

      rerender(
        <DocumentLinkResource
          resource={pdfResource}
          onOpen={jest.fn()}
          {...resourceProtectionProps}
        />
      )

      expect(screen.getByTestId('document-link-preview-card')).toBe(card)
      expect(observe).toHaveBeenCalledTimes(1)
      expect(
        screen.queryByText('document.document.detail.linkPreview.loading')
      ).not.toBeInTheDocument()
      expect(prepareRemotePdf).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(global, 'IntersectionObserver', {
        configurable: true,
        value: originalObserver,
      })
    }
  })

  it('uses the shared PDF renderer instead of an Edge-blocked iframe', async () => {
    render(
      <DocumentLinkPreview
        resource={pdfResource}
        onOpenChange={jest.fn()}
        {...previewProtectionProps}
      />
    )

    expect(await screen.findByTestId('mock-office-cover')).toHaveTextContent(pdfResource.url)
    expect(screen.queryByTestId('remote-pdf-preview')).not.toBeInTheDocument()
  })

  it('adds exactly one independent watermark to the online preview portal', async () => {
    render(
      <DocumentLinkPreview
        resource={pdfResource}
        onOpenChange={jest.fn()}
        {...previewProtectionProps}
        protectedPreview
      />
    )

    const dialog = screen.getByTestId('document-link-preview-dialog')
    expect(await within(dialog).findByTestId('knowledge-protected-content')).toBeInTheDocument()
    expect(within(dialog).getAllByTestId('knowledge-document-watermark')).toHaveLength(1)
  })

  it('does not pass the raw PDF URL to the renderer after preflight fails', async () => {
    jest
      .mocked(prepareRemotePdf)
      .mockRejectedValueOnce(new RemoteFileError('network-or-cors', 'Unverifiable range'))

    render(
      <DocumentLinkPreview
        resource={pdfResource}
        onOpenChange={jest.fn()}
        {...previewProtectionProps}
      />
    )

    expect(
      await screen.findByText('document.document.detail.linkPreview.errors.network-or-cors')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('mock-office-cover')).not.toBeInTheDocument()
    expect(mockOfficePreview).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: pdfResource.url })
    )
  })

  it('does not misreport a PDF renderer failure as a damaged file and allows retry', async () => {
    render(
      <DocumentLinkPreview
        resource={pdfResource}
        onOpenChange={jest.fn()}
        {...previewProtectionProps}
      />
    )
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
    render(
      <DocumentLinkPreview
        resource={officeResource}
        onOpenChange={jest.fn()}
        {...previewProtectionProps}
      />
    )
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
