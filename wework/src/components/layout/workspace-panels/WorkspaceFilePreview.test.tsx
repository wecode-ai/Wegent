import { render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { WorkspaceFilePreview } from './WorkspaceFilePreview'

const fileViewerMocks = vi.hoisted(() => ({
  render: vi.fn(),
}))
const codeViewMocks = vi.hoisted(() => ({
  render: vi.fn(),
}))
const appearanceMocks = vi.hoisted(() => ({
  resolvedMode: 'light' as 'dark' | 'light',
}))

vi.mock('@/components/chat/AssistantMarkdown', () => ({
  AssistantMarkdown: ({ content }: { content: string }) => (
    <div data-testid="assistant-markdown">{content}</div>
  ),
}))

vi.mock('@pierre/diffs/react', () => ({
  CodeView: (props: { options: Record<string, unknown> }) => {
    codeViewMocks.render(props)
    return <div data-testid="code-view" />
  },
}))

vi.mock('@file-viewer/react', () => ({
  default: (props: {
    filename: string
    type?: string
    options?: Record<string, unknown>
    className?: string
    'data-viewer-theme'?: string
  }) => {
    fileViewerMocks.render(props)
    return (
      <div
        data-testid="file-viewer"
        data-viewer-theme={props['data-viewer-theme']}
        className={props.className}
      >
        <div className="image-viewer">
          <div className="image-stage">
            <img alt={`${props.filename} preview`} />
          </div>
          <div className="image-lightbox">
            <img alt={`${props.filename} fullscreen preview`} />
          </div>
        </div>
      </div>
    )
  },
}))

vi.mock('@file-viewer/preset-engineering', () => ({ default: {} }))
vi.mock('@file-viewer/preset-office', () => ({ default: {} }))
vi.mock('@file-viewer/preset-lite', () => ({ default: {} }))
vi.mock('@/features/appearance', () => ({
  useOptionalAppearance: () => ({ resolvedMode: appearanceMocks.resolvedMode }),
}))

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  fileViewerMocks.render.mockClear()
  codeViewMocks.render.mockClear()
  appearanceMocks.resolvedMode = 'light'
})

const markdownFile = {
  path: '/workspace/project/README.md',
  name: 'README.md',
  content: '# Project\n\nRendered content',
  editable: true,
  revision: 'revision-1',
  truncated: false,
  size: 28,
}

test('renders Markdown files as a scrollable preview by default', () => {
  render(
    <WorkspaceFilePreview
      file={markdownFile}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  expect(screen.getByTestId('workspace-markdown-preview')).toHaveClass(
    'overflow-y-scroll',
    'scrollbar-soft'
  )
  expect(screen.getByTestId('assistant-markdown')).toHaveTextContent('# Project')
  expect(codeViewMocks.render).not.toHaveBeenCalled()
})

test('shows Markdown source without a duplicate sticky file header', () => {
  render(
    <WorkspaceFilePreview
      file={markdownFile}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
      markdownMode="source"
    />
  )

  expect(screen.getByTestId('code-view')).toBeInTheDocument()
  expect(codeViewMocks.render).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        disableFileHeader: true,
        stickyHeaders: false,
      }),
    })
  )
})

test('uses the application dark theme for code and binary previews', () => {
  document.documentElement.dataset.theme = 'dark'
  appearanceMocks.resolvedMode = 'dark'

  const { rerender } = render(
    <WorkspaceFilePreview
      file={{
        path: '/workspace/project/index.ts',
        name: 'index.ts',
        content: 'export const dark = true',
        editable: true,
        revision: 'revision-dark',
        truncated: false,
        size: 24,
      }}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  expect(screen.getByTestId('workspace-file-preview-code-view')).toHaveAttribute(
    'data-theme',
    'dark'
  )
  expect(codeViewMocks.render).toHaveBeenLastCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        themeType: 'dark',
        unsafeCSS: expect.stringContaining('rgb(var(--color-bg-base))'),
      }),
    })
  )

  rerender(
    <WorkspaceFilePreview
      file={null}
      binaryFile={{
        path: '/workspace/project/diagram.png',
        name: 'diagram.png',
        size: 5,
        file: new File(['image'], 'diagram.png', { type: 'image/png' }),
      }}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  expect(fileViewerMocks.render).toHaveBeenLastCalledWith(
    expect.objectContaining({
      'data-viewer-theme': 'dark',
      className: expect.stringContaining('wework-workspace-file-viewer'),
      options: expect.objectContaining({ theme: 'dark' }),
    })
  )

  const imageViewer = screen.getByTestId('file-viewer')
  expect(imageViewer).toHaveAttribute('data-viewer-theme', 'dark')
  expect(imageViewer).toHaveClass('wework-workspace-file-viewer')
  expect(imageViewer.querySelector('.image-viewer .image-stage img')).toHaveAttribute(
    'alt',
    'diagram.png preview'
  )
  expect(imageViewer.querySelector('.image-viewer .image-lightbox img')).toHaveAttribute(
    'alt',
    'diagram.png fullscreen preview'
  )
})

test('uses the application dark theme while editing text files', () => {
  document.documentElement.dataset.theme = 'dark'
  appearanceMocks.resolvedMode = 'dark'

  render(
    <WorkspaceFilePreview
      file={{
        path: '/workspace/project/index.ts',
        name: 'index.ts',
        content: 'export const dark = true',
        editable: true,
        revision: 'revision-dark',
        truncated: false,
        size: 24,
      }}
      loading={false}
      editing
      editedContent="export const dark = true"
      onEditedContentChange={vi.fn()}
      onSave={vi.fn()}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  expect(screen.getByTestId('workspace-file-editor')).toHaveAttribute('data-theme', 'dark')
})

test('keeps the code view mounted while switching between text files', () => {
  const { rerender } = render(
    <WorkspaceFilePreview
      file={{
        path: '/workspace/project/first.ts',
        name: 'first.ts',
        content: 'export const first = true',
        editable: true,
        revision: 'revision-1',
        truncated: false,
        size: 25,
      }}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )
  const codeView = screen.getByTestId('code-view')

  rerender(
    <WorkspaceFilePreview
      file={{
        path: '/workspace/project/second.ts',
        name: 'second.ts',
        content: 'export const second = true',
        editable: true,
        revision: 'revision-2',
        truncated: false,
        size: 26,
      }}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  expect(screen.getByTestId('code-view')).toBe(codeView)
  expect(codeViewMocks.render).toHaveBeenLastCalledWith(
    expect.objectContaining({
      items: [
        expect.objectContaining({
          id: '/workspace/project/second.ts',
        }),
      ],
    })
  )
})

test('keeps the current text preview visible while the next file is loading', () => {
  render(
    <WorkspaceFilePreview
      file={{
        path: '/workspace/project/current.ts',
        name: 'current.ts',
        content: 'export const current = true',
        editable: true,
        revision: 'revision-1',
        truncated: false,
        size: 27,
      }}
      loading
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  expect(screen.getByTestId('code-view')).toBeInTheDocument()
  expect(screen.queryByTestId('workspace-file-preview-progress')).not.toBeInTheDocument()
})

test('does not rebuild a binary image preview when its parent rerenders', () => {
  const binaryFile = {
    path: '/workspace/project/diagram.png',
    name: 'diagram.png',
    size: 5,
    file: new File(['image'], 'diagram.png', { type: 'image/png' }),
  }
  const { rerender } = render(
    <WorkspaceFilePreview
      file={null}
      binaryFile={binaryFile}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  rerender(
    <WorkspaceFilePreview
      file={null}
      binaryFile={binaryFile}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  expect(fileViewerMocks.render).toHaveBeenCalledTimes(1)
})

test.each([
  ['architecture.mmd', 'mermaid'],
  ['architecture.puml', 'plantuml'],
])('routes %s files to the diagram renderer', (name, type) => {
  const binaryFile = {
    path: `/workspace/project/${name}`,
    name,
    size: 12,
    file: new File(['diagram source'], name, { type: 'application/octet-stream' }),
  }

  render(
    <WorkspaceFilePreview
      file={null}
      binaryFile={binaryFile}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  expect(fileViewerMocks.render).toHaveBeenCalledWith(
    expect.objectContaining({
      filename: name,
      type,
    })
  )
  expect(screen.getByTestId('diagram-copy-image-button')).toBeInTheDocument()
  expect(screen.getByTestId('diagram-save-image-button')).toBeInTheDocument()
})

test('uses the current Wework theme for diagram files', () => {
  appearanceMocks.resolvedMode = 'dark'
  const name = 'architecture.mmd'
  const binaryFile = {
    path: `/workspace/project/${name}`,
    name,
    size: 12,
    file: new File(['graph LR\nA --> B'], name, { type: 'application/octet-stream' }),
  }

  render(
    <WorkspaceFilePreview
      file={null}
      binaryFile={binaryFile}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  expect(fileViewerMocks.render).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        theme: 'dark',
      }),
    })
  )
})
