import '@/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { WorkspaceAttachmentPreview } from './WorkspaceAttachmentPreview'
import { WorkspaceFilePreview } from './WorkspaceFilePreview'
import { useImperativeHandle, useRef, type ReactNode } from 'react'
import type { CodeViewItem } from '@pierre/diffs'
import JSZip from 'jszip'

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
      {content.split('\n\n').map((block, index) => (
        <p
          key={`${index}-${block}`}
          data-source-line={content.slice(0, content.indexOf(block)).split('\n').length}
        >
          {block}
        </p>
      ))}
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
  Element.prototype.scrollIntoView = vi.fn()
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

test('withholds a DOCX from the renderer until its external relationships have been secured', async () => {
  const zip = new JSZip()
  zip.file(
    'word/_rels/document.xml.rels',
    '<Relationships><Relationship Id="rId1" Type="image" TargetMode="External" Target="javascript:alert(1)"/></Relationships>'
  )
  const bytes = await zip.generateAsync({ type: 'arraybuffer' })
  const source = new File([bytes], 'unsafe.docx')
  let release: (value: ArrayBuffer) => void = () => {}
  source.arrayBuffer = () =>
    new Promise(resolve => {
      release = resolve
    })
  render(
    <WorkspaceFilePreview
      file={null}
      binaryFile={{
        path: '/workspace/unsafe.docx',
        name: source.name,
        size: source.size,
        file: source,
      }}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )
  expect(screen.getByTestId('workspace-office-preview-preparing')).toBeInTheDocument()
  expect(fileViewerMocks.render).not.toHaveBeenCalled()
  release(bytes)
  await waitFor(() => expect(fileViewerMocks.render).toHaveBeenCalled())
  for (const [props] of fileViewerMocks.render.mock.calls) expect(props.file).not.toBe(source)
})

test('keeps an invalid DOCX out of the document renderer', async () => {
  const source = new File(['invalid'], 'invalid.docx')
  source.arrayBuffer = async () => new TextEncoder().encode('invalid').buffer
  render(
    <WorkspaceFilePreview
      file={null}
      binaryFile={{
        path: '/workspace/invalid.docx',
        name: source.name,
        size: source.size,
        file: source,
      }}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )
  await waitFor(() =>
    expect(screen.getByTestId('workspace-office-preview-preparing')).toHaveTextContent(
      '读取文件失败'
    )
  )
  expect(fileViewerMocks.render).not.toHaveBeenCalled()
})

test('retries DOCX preparation on the same file without exposing unprepared bytes', async () => {
  const zip = new JSZip()
  zip.file(
    'word/_rels/document.xml.rels',
    '<Relationships><Relationship Id="rId1" Type="image" TargetMode="External" Target="javascript:alert(1)"/></Relationships>'
  )
  const bytes = await zip.generateAsync({ type: 'arraybuffer' })
  const source = new File([bytes], 'retry.docx')
  source.arrayBuffer = vi
    .fn()
    .mockRejectedValueOnce(new Error('Temporary read failure'))
    .mockResolvedValue(bytes)
  render(
    <WorkspaceFilePreview
      file={null}
      binaryFile={{
        path: '/workspace/retry.docx',
        name: source.name,
        size: source.size,
        file: source,
      }}
      loading={false}
      onRetry={vi.fn()}
    />
  )
  const retry = await screen.findByTestId('workspace-office-preview-retry-button')
  expect(fileViewerMocks.render).not.toHaveBeenCalled()
  fireEvent.click(retry)
  await waitFor(() => expect(fileViewerMocks.render).toHaveBeenCalled())
  expect(source.arrayBuffer).toHaveBeenCalledTimes(2)
  for (const [props] of fileViewerMocks.render.mock.calls) expect(props.file).not.toBe(source)
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

test('keeps markdown preview unanchored without a target line', () => {
  const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView)
  render(
    <WorkspaceFilePreview
      file={{
        path: '/workspace/project/README.md',
        name: 'README.md',
        content: '# Title\n\nFirst paragraph.\n\nSecond paragraph.',
        editable: true,
        revision: 'revision-1',
        truncated: false,
        size: 44,
      }}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  expect(screen.getByTestId('workspace-markdown-preview')).toBeInTheDocument()
  expect(scrollIntoView).not.toHaveBeenCalled()
})

test('scrolls and highlights the rendered source block for a target line', () => {
  const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView)
  render(
    <WorkspaceFilePreview
      file={{
        path: '/workspace/project/README.md',
        name: 'README.md',
        content: '# Title\n\nFirst paragraph.\n\nSecond paragraph.',
        editable: true,
        revision: 'revision-1',
        truncated: false,
        size: 44,
      }}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
      targetLineStart={5}
    />
  )

  const target = scrollIntoView.mock.contexts.at(-1) as HTMLElement
  expect(target).toHaveTextContent('Second paragraph.')
  expect(target).toHaveAttribute('data-source-line', '5')
  expect(target).toHaveAttribute('data-source-line-target', 'true')
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
})

test('prefers the closest preceding rendered block for a line inside a block', () => {
  const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView)
  render(
    <WorkspaceFilePreview
      file={{
        path: '/workspace/project/README.md',
        name: 'README.md',
        content: '# Title\n\nFirst paragraph.\n\nSecond paragraph.',
        editable: true,
        revision: 'revision-1',
        truncated: false,
        size: 44,
      }}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
      targetLineStart={3}
    />
  )

  const target = scrollIntoView.mock.contexts.at(-1) as HTMLElement
  expect(target).toHaveTextContent('First paragraph.')
  expect(target).toHaveAttribute('data-source-line', '3')
})

test('warns when a truncated HTML preview hides content', () => {
  render(
    <WorkspaceFilePreview
      file={{
        path: '/workspace/project/index.html',
        name: 'index.html',
        content: '<!doctype html><h1>Truncated</h1>',
        editable: true,
        revision: 'revision-1',
        truncated: true,
        size: 262_144,
      }}
      loading={false}
      onRetry={vi.fn()}
      onAddCodeComment={vi.fn()}
    />
  )

  expect(screen.getByTestId('workspace-html-file-preview')).toBeInTheDocument()
  expect(screen.getByTestId('workspace-html-file-preview-truncated')).toHaveTextContent(
    '文件过大，仅显示前 256 KiB'
  )
})
