import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { copyTextToClipboard } from '@/lib/clipboard'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { FileWorkspacePanel } from './FileWorkspacePanel'

vi.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: vi.fn(),
}))

vi.mock('@/components/chat/AssistantMarkdown', () => ({
  AssistantMarkdown: ({ content }: { content: string }) => (
    <div data-testid="assistant-markdown">{content}</div>
  ),
}))

vi.mock('@pierre/trees/react', () => ({
  FileTree: ({
    model,
    ...props
  }: {
    model: {
      paths: string[]
      onSelectionChange?: (paths: string[]) => void
    }
  }) => (
    <div {...props}>
      {model.paths.map(path => (
        <button key={path} type="button" onClick={() => model.onSelectionChange?.([path])}>
          {path.replace(/\/+$/, '').split('/').pop()}
        </button>
      ))}
    </div>
  ),
  useFileTree: ({
    paths,
    onSelectionChange,
  }: {
    paths: string[]
    onSelectionChange?: (paths: string[]) => void
  }) => ({
    model: {
      paths,
      onSelectionChange,
      setSearch: vi.fn(),
      getItem: vi.fn(() => ({ expand: vi.fn() })),
    },
  }),
}))

vi.mock('@pierre/diffs/react', () => ({
  CodeView: () => <div data-testid="workspace-code-view" />,
}))

const copyTextToClipboardMock = vi.mocked(copyTextToClipboard)

const target: WorkspaceTarget = {
  deviceId: 'device-1',
  path: '/workspace/project',
  source: 'project',
  workspaceSource: 'remote',
}

function createTextFile(path: string, name: string) {
  return {
    path,
    name,
    content: `content of ${name}`,
    editable: true,
    revision: `revision-${name}`,
    truncated: false,
    size: 10,
    modifiedAt: null,
  }
}

function createRootEntries() {
  return [
    {
      name: 'src',
      path: '/workspace/project/src',
      isDirectory: true,
      size: 0,
      modifiedAt: null,
    },
    {
      name: 'README.md',
      path: '/workspace/project/README.md',
      isDirectory: false,
      size: 10,
      modifiedAt: null,
    },
  ]
}

function renderPanel(overrides?: {
  openFileRequest?: Parameters<typeof FileWorkspacePanel>[0]['openFileRequest']
  initialSelection?: Parameters<typeof FileWorkspacePanel>[0]['initialSelection']
  onSelectionChange?: Parameters<typeof FileWorkspacePanel>[0]['onSelectionChange']
}) {
  const listWorkspaceEntries = vi.fn((_deviceId: string, path: string) =>
    Promise.resolve({
      path,
      entries: path === '/workspace/project' ? createRootEntries() : [],
    })
  )
  const readWorkspaceTextFile = vi.fn((_deviceId: string, path: string) =>
    Promise.resolve(createTextFile(path, path.split('/').pop() ?? path))
  )

  const utils = render(
    <FileWorkspacePanel
      target={target}
      openFileRequest={overrides?.openFileRequest}
      initialSelection={overrides?.initialSelection}
      onSelectionChange={overrides?.onSelectionChange}
      workspaceFileApi={{ listWorkspaceEntries, readWorkspaceTextFile }}
      onAddCodeComment={vi.fn()}
    />
  )

  return { listWorkspaceEntries, readWorkspaceTextFile, ...utils }
}

describe('FileWorkspacePanel copy relative path', () => {
  beforeEach(() => {
    copyTextToClipboardMock.mockReset()
    copyTextToClipboardMock.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('hides the copy button until a file is selected', async () => {
    renderPanel()

    await screen.findByText('README.md')

    expect(screen.queryByTestId('workspace-file-copy-relative-path-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-file-copy-relative-path-feedback')).toHaveTextContent('')
  })

  test('copies the workspace-relative path for a selected file and announces success', async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.click(await screen.findByText('README.md'))
    const copyButton = await screen.findByTestId('workspace-file-copy-relative-path-button')

    await user.click(copyButton)

    await waitFor(() => expect(copyTextToClipboardMock).toHaveBeenCalledWith('README.md'))
    expect(screen.getByTestId('workspace-file-copy-relative-path-button')).toHaveTextContent(
      '已复制'
    )
    expect(screen.getByTestId('workspace-file-copy-relative-path-feedback')).toHaveTextContent(
      '已复制相对路径 README.md'
    )
  })

  test('copies a nested path relative to the workspace root', async () => {
    const user = userEvent.setup()
    renderPanel({
      openFileRequest: {
        id: 'open-nested',
        path: '/workspace/project/src/index.ts',
        lineStart: 1,
      },
    })

    const copyButton = await screen.findByTestId('workspace-file-copy-relative-path-button')
    await user.click(copyButton)

    await waitFor(() => expect(copyTextToClipboardMock).toHaveBeenCalledWith('src/index.ts'))
  })

  test('hides the copy button for directory selections', async () => {
    const onSelectionChange = vi.fn()
    renderPanel({
      initialSelection: { path: '/workspace/project/src', isDirectory: true },
      onSelectionChange,
    })

    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenCalledWith({
        path: '/workspace/project/src',
        isDirectory: true,
      })
    )
    expect(screen.queryByTestId('workspace-file-copy-relative-path-button')).not.toBeInTheDocument()
  })

  test('hides the copy button for the workspace-root selection', async () => {
    const onSelectionChange = vi.fn()
    renderPanel({
      initialSelection: { path: '/workspace/project', isDirectory: true },
      onSelectionChange,
    })

    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenCalledWith({
        path: '/workspace/project',
        isDirectory: true,
      })
    )
    expect(screen.queryByTestId('workspace-file-copy-relative-path-button')).not.toBeInTheDocument()
  })

  test('announces a failure when copying is rejected', async () => {
    const user = userEvent.setup()
    copyTextToClipboardMock.mockRejectedValue(new Error('clipboard denied'))
    renderPanel()

    await user.click(await screen.findByText('README.md'))
    await user.click(await screen.findByTestId('workspace-file-copy-relative-path-button'))

    await waitFor(() => expect(copyTextToClipboardMock).toHaveBeenCalledWith('README.md'))
    expect(screen.getByTestId('workspace-file-copy-relative-path-button')).toHaveTextContent(
      '复制失败'
    )
    expect(screen.getByTestId('workspace-file-copy-relative-path-feedback')).toHaveTextContent(
      '复制相对路径失败 README.md'
    )
  })

  test('clears old copy feedback when switching files', async () => {
    const user = userEvent.setup()
    const { rerender } = renderPanel({
      openFileRequest: { id: 'open-first', path: '/workspace/project/README.md', lineStart: 1 },
    })

    await user.click(await screen.findByTestId('workspace-file-copy-relative-path-button'))
    await waitFor(() => expect(copyTextToClipboardMock).toHaveBeenCalledWith('README.md'))
    expect(screen.getByTestId('workspace-file-copy-relative-path-button')).toHaveTextContent(
      '已复制'
    )

    rerender(
      <FileWorkspacePanel
        target={target}
        openFileRequest={{
          id: 'open-second',
          path: '/workspace/project/src/index.ts',
          lineStart: 1,
        }}
        workspaceFileApi={{
          listWorkspaceEntries: vi.fn(),
          readWorkspaceTextFile: vi
            .fn()
            .mockResolvedValue(createTextFile('/workspace/project/src/index.ts', 'index.ts')),
        }}
        onAddCodeComment={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('workspace-file-copy-relative-path-button')).toHaveTextContent(
        '复制相对路径'
      )
    })
    expect(screen.getByTestId('workspace-file-copy-relative-path-feedback')).toHaveTextContent('')
    await user.click(screen.getByTestId('workspace-file-copy-relative-path-button'))
    await waitFor(() => expect(copyTextToClipboardMock).toHaveBeenCalledWith('src/index.ts'))
  })

  test('does not surface stale feedback when the file changes while copying', async () => {
    const user = userEvent.setup()
    let resolveCopy!: () => void
    copyTextToClipboardMock.mockReturnValue(
      new Promise(resolve => {
        resolveCopy = resolve
      })
    )
    const { rerender } = renderPanel({
      openFileRequest: { id: 'open-first', path: '/workspace/project/README.md', lineStart: 1 },
    })

    await user.click(await screen.findByTestId('workspace-file-copy-relative-path-button'))

    rerender(
      <FileWorkspacePanel
        target={target}
        openFileRequest={{
          id: 'open-second',
          path: '/workspace/project/src/index.ts',
          lineStart: 1,
        }}
        workspaceFileApi={{
          listWorkspaceEntries: vi.fn(),
          readWorkspaceTextFile: vi
            .fn()
            .mockResolvedValue(createTextFile('/workspace/project/src/index.ts', 'index.ts')),
        }}
        onAddCodeComment={vi.fn()}
      />
    )

    await waitFor(() => expect(copyTextToClipboardMock).toHaveBeenCalledWith('README.md'))
    await act(async () => {
      resolveCopy()
      await Promise.resolve()
    })

    expect(screen.getByTestId('workspace-file-copy-relative-path-button')).toHaveTextContent(
      '复制相对路径'
    )
    expect(screen.getByTestId('workspace-file-copy-relative-path-feedback')).toHaveTextContent('')
  })
})
