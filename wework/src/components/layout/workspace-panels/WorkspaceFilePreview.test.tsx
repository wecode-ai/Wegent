import '@/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { WorkspaceAttachmentPreview } from './WorkspaceAttachmentPreview'
import { WorkspaceFilePreview } from './WorkspaceFilePreview'
import { useImperativeHandle, useRef, type ReactNode } from 'react'
import type { CodeViewItem } from '@pierre/diffs'

const fileViewerMocks = vi.hoisted(() => ({
  render: vi.fn(),
}))
const codeViewMocks = vi.hoisted(() => ({
  render: vi.fn(),
  updateItem: vi.fn(),
  addItems: vi.fn(),
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

vi.mock('@/components/code/PierreCodeProvider', () => ({
  PierreCodeProvider: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@pierre/diffs/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@pierre/diffs/react')>()),
  CodeView: (props: {
    ref?: React.Ref<unknown>
    initialItems: CodeViewItem<undefined>[]
    options: Record<string, unknown>
    selectedLines?: unknown
    style?: Record<string, string>
  }) => {
    const item = useRef(props.initialItems[0])
    useImperativeHandle(props.ref, () => ({
      getItem: (id: string) => (item.current?.id === id ? item.current : undefined),
      removeItem: () => {
        item.current = undefined as unknown as CodeViewItem<undefined>
      },
      addItems: (items: CodeViewItem<undefined>[]) => {
        item.current = items[0]
        codeViewMocks.addItems(items)
      },
      updateItem: (next: CodeViewItem<undefined>) => {
        item.current = next
        codeViewMocks.updateItem(next)
      },
      scrollTo: vi.fn(),
    }))
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

test.each(['csv', 'tsv'])('keeps %s attachments in the read-only table viewer', async extension => {
  render(
    <WorkspaceAttachmentPreview
      source={{
        filename: `test-data.${extension}`,
        contentType: extension === 'csv' ? 'text/csv' : 'text/tab-separated-values',
        loadFile: async () => new Blob(['test,value\none,two']),
      }}
    />
  )
  await waitFor(() =>
    expect(fileViewerMocks.render).toHaveBeenCalledWith(
      expect.objectContaining({ filename: `test-data.${extension}`, type: 'csv' })
    )
  )
  expect(codeViewMocks.render).not.toHaveBeenCalled()
})

test('retries a failed text attachment read and displays the complete read-only file', async () => {
  const content = '完整文本\n'.repeat(30000)
  const loadFile = vi
    .fn()
    .mockRejectedValueOnce(new Error('Attachment is temporarily unavailable'))
    .mockResolvedValueOnce(new Blob([content], { type: 'text/plain' }))
  render(
    <WorkspaceAttachmentPreview
      source={{ filename: 'clipboard.txt', contentType: 'text/plain', loadFile }}
    />
  )
  expect(await screen.findByText('Attachment is temporarily unavailable')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('workspace-file-preview-retry-button'))
  await waitFor(() =>
    expect(codeViewMocks.render).toHaveBeenCalledWith(
      expect.objectContaining({
        initialItems: [
          expect.objectContaining({ file: expect.objectContaining({ contents: content }) }),
        ],
      })
    )
  )
  expect(loadFile).toHaveBeenCalledTimes(2)
  expect(screen.queryByTestId('workspace-file-editor')).not.toBeInTheDocument()
  expect(screen.getByTestId('composer-attachment-preview-download')).toBeEnabled()
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
