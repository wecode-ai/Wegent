import { act, fireEvent, render, screen } from '@testing-library/react'
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
  codeFontSize: 12,
}))

vi.mock('@/components/chat/AssistantMarkdown', () => ({
  AssistantMarkdown: ({ content, variant }: { content: string; variant?: string }) => (
    <div data-testid="assistant-markdown" data-variant={variant}>
      {content}
    </div>
  ),
}))

vi.mock('@pierre/diffs/react', () => ({
  CodeView: (props: {
    options: Record<string, unknown>
    selectedLines?: unknown
    style?: Record<string, string>
  }) => {
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
  defaultAppearance: { codeFontSize: 12 },
  useOptionalAppearance: () => ({
    resolvedMode: appearanceMocks.resolvedMode,
    appearance: { codeFontSize: appearanceMocks.codeFontSize },
  }),
}))

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  fileViewerMocks.render.mockClear()
  codeViewMocks.render.mockClear()
  appearanceMocks.resolvedMode = 'light'
  appearanceMocks.codeFontSize = 12
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
  expect(screen.getByTestId('assistant-markdown')).toHaveAttribute('data-variant', 'document')
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

test('drags selected preview lines as plain text', () => {
  render(
    <WorkspaceFilePreview
      file={{
        path: '/workspace/project/index.ts',
        name: 'index.ts',
        content: 'const first = 1\nconst second = 2\nconst third = 3',
        editable: true,
        revision: 'revision-selection',
        truncated: false,
        size: 48,
      }}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  const props = codeViewMocks.render.mock.lastCall?.[0] as {
    onSelectedLinesChange: (selection: {
      id: string
      range: { start: number; end: number }
    }) => void
  }
  act(() => {
    props.onSelectedLinesChange({
      id: '/workspace/project/index.ts',
      range: { start: 1, end: 2 },
    })
  })

  const preview = screen.getByTestId('workspace-file-preview')
  expect(preview).toHaveAttribute('draggable', 'true')
  const setData = vi.fn()
  const dataTransfer = { setData, effectAllowed: 'none' } as unknown as DataTransfer
  fireEvent.dragStart(preview, { dataTransfer })

  expect(setData).toHaveBeenCalledWith('text/plain', 'const first = 1\nconst second = 2')
  expect(dataTransfer.effectAllowed).toBe('copy')
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

test('keeps CodeView configuration stable across unrelated parent rerenders', () => {
  const file = {
    path: '/workspace/project/index.ts',
    name: 'index.ts',
    content: 'export const stable = true',
    editable: true,
    revision: 'revision-stable',
    truncated: false,
    size: 26,
  }
  const { rerender } = render(
    <WorkspaceFilePreview
      file={file}
      loading={false}
      targetLineStart={1}
      targetLineEnd={1}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )
  const firstProps = codeViewMocks.render.mock.lastCall?.[0] as {
    items: unknown
    onSelectedLinesChange: unknown
    options: unknown
    selectedLines: unknown
  }

  rerender(
    <WorkspaceFilePreview
      file={file}
      loading
      targetLineStart={1}
      targetLineEnd={1}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )
  const nextProps = codeViewMocks.render.mock.lastCall?.[0] as typeof firstProps

  expect(nextProps.items).toBe(firstProps.items)
  expect(nextProps.onSelectedLinesChange).toBe(firstProps.onSelectedLinesChange)
  expect(nextProps.options).toBe(firstProps.options)
  expect(nextProps.selectedLines).toBe(firstProps.selectedLines)
})

test('keeps code view metrics aligned with the configured font size', () => {
  appearanceMocks.codeFontSize = 13

  render(
    <WorkspaceFilePreview
      file={{
        path: '/workspace/project/index.ts',
        name: 'index.ts',
        content: 'export const value = true',
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

  const expectedLineHeight = Math.round(13 * 1.8)
  expect(codeViewMocks.render).toHaveBeenLastCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        itemMetrics: { lineHeight: expectedLineHeight },
        layout: { paddingTop: 0, paddingBottom: expectedLineHeight, gap: 0 },
        unsafeCSS: expect.stringContaining('--wework-workspace-code-line-height'),
      }),
      style: expect.objectContaining({
        '--wework-workspace-code-line-height': `${expectedLineHeight}px`,
      }),
    })
  )
})

test('copies the complete file after selecting all lines with the keyboard shortcut', () => {
  const content = Array.from({ length: 200 }, (_, index) => `第 ${index + 1} 行`).join('\n')

  render(
    <WorkspaceFilePreview
      file={{
        path: '/workspace/project/demo.sh',
        name: 'demo.sh',
        content,
        editable: true,
        revision: 'revision-1',
        truncated: false,
        size: content.length,
      }}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  fireEvent.keyDown(screen.getByTestId('workspace-file-preview'), {
    key: 'a',
    ctrlKey: true,
  })

  expect(codeViewMocks.render).toHaveBeenLastCalledWith(
    expect.objectContaining({
      selectedLines: {
        id: '/workspace/project/demo.sh',
        range: { start: 1, end: 200 },
      },
    })
  )
  expect(screen.queryByTestId('workspace-file-comment-input')).not.toBeInTheDocument()

  const clipboardData = { setData: vi.fn() }
  fireEvent.copy(screen.getByTestId('workspace-file-preview'), { clipboardData })

  expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', content)
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
