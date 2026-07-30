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
  default: (props: { filename: string }) => {
    fileViewerMocks.render(props)
    return <div data-testid="file-viewer">{props.filename}</div>
  },
}))

vi.mock('@file-viewer/preset-engineering', () => ({ default: {} }))
vi.mock('@file-viewer/preset-office', () => ({ default: {} }))
vi.mock('@file-viewer/preset-lite', () => ({ default: {} }))

beforeEach(() => {
  fileViewerMocks.render.mockClear()
  codeViewMocks.render.mockClear()
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
