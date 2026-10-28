// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { DocumentContentViewer } from '@/features/knowledge/document/components/DocumentContentViewer'
import { loadBoundedRemoteFile } from '@/features/knowledge/document/utils/boundedRemoteFile'

const href = 'https://cdn.example.com/guide.pdf?Expires=9999999999&Signature=test'
const markdown = `[Guide](${href})`
const mockTranslate = (key: string) => key
const mockRouter = { push: jest.fn() }
let mockTheme = 'light'

// Exercise the real preprocessing and Markdown tree instead of the global text-only mocks.
jest.mock('react-markdown', () =>
  jest.requireActual('../../../../../node_modules/react-markdown/index.js')
)
jest.mock('@/lib/remark-gfm-safe', () => jest.requireActual('../../../../lib/remark-gfm-safe.ts'))
jest.mock('rehype-raw', () => jest.requireActual('../../../../../node_modules/rehype-raw/index.js'))
jest.mock('@/components/common/SmartUrlRenderer', () => ({
  createSmartMarkdownComponents: () => ({
    img: ({ src, alt }: { src?: string; alt?: string }) => (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={alt} data-testid="original-markdown-image" />
    ),
  }),
}))
jest.mock('@/components/common/FilePreview/preview-renderers/FlyfishOfficePreview', () => ({
  FlyfishOfficePreview: () => <div data-testid="pdf-cover-renderer" />,
}))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}))
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }))
jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: mockTheme }),
}))
jest.mock('@/features/knowledge/multimodal/components/InlineImageViewer', () => ({
  InlineImageViewer: () => null,
  isImageDocument: () => false,
}))
jest.mock('@/features/knowledge/document/utils/boundedRemoteFile', () => ({
  loadBoundedRemoteFile: jest.fn().mockResolvedValue({ blob: new Blob(['image']) }),
  prepareRemotePdf: jest.fn().mockResolvedValue({
    mimeType: 'application/pdf',
    size: 8,
    supportsRange: true,
  }),
  probeRemoteVideo: jest.fn(),
}))

beforeAll(async () => {
  // Surface module-loading errors instead of leaving Next's dynamic fallback visible.
  await import('@/components/common/EnhancedMarkdown')
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
  mockTheme = 'light'
})

const props: ComponentProps<typeof DocumentContentViewer> = {
  content: markdown,
  document: {
    id: 1149,
    name: 'Linked document',
    source_type: 'external',
    external_provider: 'dingtalk',
    source_config: {},
    file_extension: 'md',
  } as ComponentProps<typeof DocumentContentViewer>['document'],
  knowledgeBaseId: 246,
  knowledgeBaseName: 'knowledge',
  knowledgeBaseNamespace: 'default',
  isOrganization: false,
  viewMode: 'preview',
  hasMoreContent: false,
  loadingMore: false,
  onLoadMore: jest.fn(),
  onOpenChange: jest.fn(),
}

it.each(['file', 'text', 'wiki'] as const)(
  'keeps original links and direct image loading for non-DingTalk %s documents',
  async source => {
    jest.mocked(loadBoundedRemoteFile).mockClear()
    render(
      <DocumentContentViewer
        {...props}
        document={{
          ...props.document,
          source_type: source === 'wiki' ? 'external' : source,
          external_provider: source === 'wiki' ? 'wiki' : undefined,
          source_config: source === 'wiki' ? { external: { provider: 'wiki' } } : {},
        }}
        content={`${markdown}\n\n![Image](https://cdn.example.com/image.jpeg)`}
      />
    )
    expect(await screen.findByAltText('Image')).toHaveAttribute(
      'src',
      'https://cdn.example.com/image.jpeg'
    )
    expect(screen.getByRole('link', { name: 'Guide' })).toHaveAttribute('href', href)
    expect(screen.getByAltText('Image')).toHaveAttribute('data-testid', 'original-markdown-image')
    expect(screen.queryByTestId('document-link-preview-trigger')).not.toBeInTheDocument()
    expect(loadBoundedRemoteFile).not.toHaveBeenCalled()
  }
)

it.each(['light', 'dark'])('uses a theme-aware document surface in %s mode', async theme => {
  mockTheme = theme
  const { container } = render(
    <DocumentContentViewer
      {...props}
      document={{ ...props.document, source_type: 'file', external_provider: undefined }}
      content={'# 故障案例\n\n| 字段 | 内容 |\n| --- | --- |\n| 级别 | P1 |'}
    />
  )
  await screen.findByRole('heading', { name: '故障案例' })
  expect(container.querySelector('.wmde-markdown')).toHaveAttribute('data-color-mode', theme)
  expect(container.firstElementChild).toHaveClass('bg-surface')
  expect(container.firstElementChild).not.toHaveClass('bg-white')
  expect(screen.getByRole('table')).toHaveTextContent('P1')
  expect(screen.queryByTestId('document-link-preview-card')).not.toBeInTheDocument()
})

it('places standalone file cards outside paragraph elements', async () => {
  render(<DocumentContentViewer {...props} />)
  const card = await screen.findByTestId('document-link-preview-card')
  expect(card.closest('p')).toBeNull()
  await screen.findByTestId('pdf-cover-renderer')
})

it('keeps an existing cover mounted when only its parent callbacks change', async () => {
  const { rerender } = render(<DocumentContentViewer {...props} />)
  const card = await screen.findByTestId('document-link-preview-card')
  await screen.findByTestId('pdf-cover-renderer')

  rerender(<DocumentContentViewer {...props} onLoadMore={jest.fn()} />)
  expect(screen.getByTestId('document-link-preview-card')).toBe(card)

  fireEvent.click(screen.getByTestId('document-link-preview-trigger'))
  expect(screen.getByTestId('document-link-preview-card')).toBe(card)
  expect(screen.getByTestId('document-link-preview-dialog')).toBeInTheDocument()
  await within(screen.getByTestId('document-link-preview-dialog')).findByTestId(
    'pdf-cover-renderer'
  )
})

it('renders an inline file as Markdown link text without nesting a card in the paragraph', async () => {
  render(<DocumentContentViewer {...props} content={`Read ${markdown}`} />)
  const link = await screen.findByTestId('document-link-preview-trigger')
  expect(link.textContent).toContain(markdown)
  expect(link.closest('p')).not.toBeNull()
  expect(screen.queryByTestId('document-link-preview-card')).not.toBeInTheDocument()
})

it('preserves Markdown link syntax and URLs in the source-text view', () => {
  const { container } = render(<DocumentContentViewer {...props} viewMode="raw" />)
  expect(container.querySelector('pre')).toHaveTextContent(markdown)
  expect(screen.queryByTestId('document-link-preview-card')).not.toBeInTheDocument()
})

it('preserves normal hyperlinks for unrestricted, non-DingTalk documents', async () => {
  render(
    <DocumentContentViewer
      {...props}
      document={{ ...props.document, source_type: 'text', external_provider: undefined }}
    />
  )
  expect(await screen.findByRole('link', { name: 'Guide' })).toHaveAttribute('href', href)
  expect(screen.queryByTestId('document-link-preview-card')).not.toBeInTheDocument()
  expect(screen.queryByTestId('document-link-preview-trigger')).not.toBeInTheDocument()
})

it('renders a PDF whose Markdown label is its URL without leftover link syntax', async () => {
  const { container } = render(<DocumentContentViewer {...props} content={`[${href}](${href})`} />)

  expect(await screen.findByTestId('document-link-preview-card')).toBeInTheDocument()
  await screen.findByTestId('pdf-cover-renderer')
  expect(container.textContent).not.toContain('](')
  expect(container.querySelector('p [data-testid="document-link-preview-card"]')).toBeNull()
})

it.each([
  '**图片**\n![北方降雨量 (1).jpeg](https://cdn.example.com/image.jpeg)',
  '**图片**  \n![北方降雨量 (1).jpeg](https://cdn.example.com/image.jpeg)',
  '**![北方降雨量 (1).jpeg](https://cdn.example.com/image.jpeg)**',
  '**图片**\n[北方降雨量 (1).jpeg](https://cdn.example.com/image.jpeg)',
  '<strong><img src="https://cdn.example.com/image.jpeg" alt="Image"></strong>',
])('renders an image on its own line or wrapped in formatting: %s', async content => {
  const { container } = render(<DocumentContentViewer {...props} content={content} />)

  expect(await screen.findByTestId('document-link-image-cover')).toHaveAttribute(
    'src',
    'blob:https://localhost/image-cover'
  )
  const card = screen.getByTestId('document-link-preview-card')
  expect(card.closest('p, strong, em, a, button')).toBeNull()
  expect(container.querySelectorAll('[data-testid="document-link-preview-card"]')).toHaveLength(1)
})

it('renders separate resources on consecutive lines without losing the surrounding text', async () => {
  render(
    <DocumentContentViewer
      {...props}
      content={`**Attachments**\n**${markdown}**\n![Image](https://cdn.example.com/image.jpeg)\nEnd`}
    />
  )

  await screen.findByTestId('pdf-cover-renderer')
  await screen.findByTestId('document-link-image-cover')
  expect(screen.getAllByTestId('document-link-preview-card')).toHaveLength(2)
  expect(screen.getByText('Attachments')).toBeInTheDocument()
  expect(screen.getByText('End')).toBeInTheDocument()
})

it.each([`Read **${markdown}** now.`, `# ${markdown}`, `| File |\n| --- |\n| ${markdown} |`])(
  'preserves compact links in prose, headings, and tables: %s',
  async content => {
    render(<DocumentContentViewer {...props} content={content} />)

    expect(await screen.findByTestId('document-link-preview-trigger')).toBeInTheDocument()
    expect(screen.queryByTestId('document-link-preview-card')).not.toBeInTheDocument()
  }
)

it('preserves ordinary image and paragraph rendering outside restricted documents', async () => {
  const { container } = render(
    <DocumentContentViewer
      {...props}
      document={{ ...props.document, source_type: 'text', external_provider: undefined }}
      content={'**图片**\n![Image](https://cdn.example.com/image.jpeg)'}
    />
  )

  expect(await screen.findByAltText('Image')).toHaveAttribute(
    'src',
    'https://cdn.example.com/image.jpeg'
  )
  expect(container.querySelector('p > strong')).toHaveTextContent('图片')
  expect(screen.queryByTestId('document-link-preview-card')).not.toBeInTheDocument()
})

it.each([1, 2, 3, 4, 5, 6])(
  'renders the synced image appended directly to a level-%i heading as a separate cover',
  async level => {
    // The source document puts the image directly after the heading, without a newline.
    const content = `${'#'.repeat(level)} **图片**![北方降雨量 (1).jpeg](https://cdn.example.com/image.jpeg?Expires=9999999999&Signature=test "")`
    render(<DocumentContentViewer {...props} content={content} />)

    expect(await screen.findByTestId('document-link-image-cover')).toHaveAttribute(
      'src',
      'blob:https://localhost/image-cover'
    )
    const heading = screen.getByRole('heading', { level, name: '图片' })
    const card = screen.getByTestId('document-link-preview-card')
    expect(heading.nextElementSibling).toContainElement(card)
    expect(card.closest('h1, h2, h3, h4, h5, h6, p, strong, em, a, button')).toBeNull()
    expect(screen.getByTestId('document-link-preview-trigger')).not.toHaveTextContent('](')
  }
)

it('keeps PDF and image hyperlinks in headings compact rather than treating them as images', async () => {
  render(
    <DocumentContentViewer
      {...props}
      content={`## **PDF**${markdown}\n\n## **图片**[Image](https://cdn.example.com/image.jpeg)`}
    />
  )

  expect(await screen.findAllByTestId('document-link-preview-trigger')).toHaveLength(2)
  expect(screen.queryByTestId('document-link-preview-card')).not.toBeInTheDocument()
})

it('does not alter heading images in unrestricted documents', async () => {
  render(
    <DocumentContentViewer
      {...props}
      document={{ ...props.document, source_type: 'text', external_provider: undefined }}
      content={'## **图片**![Image](https://cdn.example.com/image.jpeg "")'}
    />
  )

  const image = await screen.findByAltText('Image')
  expect(image.closest('h2')).not.toBeNull()
  expect(image).toHaveAttribute('src', 'https://cdn.example.com/image.jpeg')
  expect(screen.queryByTestId('document-link-preview-card')).not.toBeInTheDocument()
})
