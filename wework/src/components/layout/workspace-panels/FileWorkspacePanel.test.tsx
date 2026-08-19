import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { copyTextToClipboard } from '@/lib/clipboard'
import { FileWorkspacePanel } from './FileWorkspacePanel'
import { workspaceRelativeFilePath } from './workspaceFilePath'

vi.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: vi.fn(),
}))

vi.mock('./WorkspaceFilePreview', () => ({
  WorkspaceFilePreview: () => <div data-testid="workspace-file-preview-test-double" />,
}))

const mockedCopyTextToClipboard = vi.mocked(copyTextToClipboard)

describe('FileWorkspacePanel relative path copy', () => {
  beforeEach(() => {
    mockedCopyTextToClipboard.mockReset()
    mockedCopyTextToClipboard.mockResolvedValue(undefined)
  })

  test('copies the selected file path relative to the current workspace root and confirms success', async () => {
    const user = userEvent.setup()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [
        {
          name: 'main.ts',
          path: '/workspace/project/src/main.ts',
          isDirectory: false,
          size: 24,
          modifiedAt: null,
        },
      ],
    })
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/src/main.ts',
      name: 'main.ts',
      content: 'export const ready = true',
      editable: false,
      truncated: false,
      size: 24,
      modifiedAt: null,
    })

    render(
      <FileWorkspacePanel
        target={{
          deviceId: 'workspace-device',
          path: '/workspace/project',
          source: 'project',
          workspaceSource: 'remote',
        }}
        initialSelection={{
          path: '/workspace/project/src/main.ts',
          isDirectory: false,
        }}
        workspaceFileApi={{ listWorkspaceEntries, readWorkspaceTextFile }}
        onAddCodeComment={vi.fn()}
      />
    )

    const copyButton = await screen.findByTestId('workspace-file-copy-relative-path-button')
    await user.click(copyButton)

    expect(mockedCopyTextToClipboard).toHaveBeenCalledWith('src/main.ts')
    expect(screen.getByTestId('workspace-file-relative-path-copied-status')).toHaveTextContent(
      '已复制相对路径'
    )
    expect(screen.getByRole('status')).toBeVisible()
  })

  test('does not show the file action when the selected path is a directory', async () => {
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [
        {
          name: 'src',
          path: '/workspace/project/src',
          isDirectory: true,
          size: 0,
          modifiedAt: null,
        },
      ],
    })

    render(
      <FileWorkspacePanel
        target={{
          deviceId: 'workspace-device',
          path: '/workspace/project',
          source: 'project',
          workspaceSource: 'remote',
        }}
        initialSelection={{
          path: '/workspace/project/src',
          isDirectory: true,
        }}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile: vi.fn(),
        }}
        onAddCodeComment={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('workspace-file-path')).toHaveTextContent('/workspace/project/src')
    )
    expect(screen.queryByTestId('workspace-file-copy-relative-path-button')).not.toBeInTheDocument()
    expect(mockedCopyTextToClipboard).not.toHaveBeenCalled()
  })

  test('does not show the file action when the workspace root itself is selected', async () => {
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [
        {
          name: 'src',
          path: '/workspace/project/src',
          isDirectory: true,
          size: 0,
          modifiedAt: null,
        },
      ],
    })

    render(
      <FileWorkspacePanel
        target={{
          deviceId: 'workspace-device',
          path: '/workspace/project',
          source: 'project',
          workspaceSource: 'remote',
        }}
        initialSelection={{
          path: '/workspace/project',
          isDirectory: true,
        }}
        workspaceFileApi={{
          listWorkspaceEntries,
          readWorkspaceTextFile: vi.fn(),
        }}
        onAddCodeComment={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('workspace-file-path')).toHaveTextContent('/workspace/project')
    )
    expect(screen.queryByTestId('workspace-file-copy-relative-path-button')).not.toBeInTheDocument()
    expect(mockedCopyTextToClipboard).not.toHaveBeenCalled()
  })

  test('shows failure feedback when copying the relative path fails', async () => {
    mockedCopyTextToClipboard.mockRejectedValue(new Error('clipboard unavailable'))
    const user = userEvent.setup()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [
        {
          name: 'main.ts',
          path: '/workspace/project/src/main.ts',
          isDirectory: false,
          size: 24,
          modifiedAt: null,
        },
      ],
    })
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/src/main.ts',
      name: 'main.ts',
      content: 'export const ready = true',
      editable: false,
      truncated: false,
      size: 24,
      modifiedAt: null,
    })

    render(
      <FileWorkspacePanel
        target={{
          deviceId: 'workspace-device',
          path: '/workspace/project',
          source: 'project',
          workspaceSource: 'remote',
        }}
        initialSelection={{
          path: '/workspace/project/src/main.ts',
          isDirectory: false,
        }}
        workspaceFileApi={{ listWorkspaceEntries, readWorkspaceTextFile }}
        onAddCodeComment={vi.fn()}
      />
    )

    const copyButton = await screen.findByTestId('workspace-file-copy-relative-path-button')
    await user.click(copyButton)

    expect(mockedCopyTextToClipboard).toHaveBeenCalledWith('src/main.ts')
    expect(screen.getByTestId('workspace-file-relative-path-copy-failed-status')).toHaveTextContent(
      '复制相对路径失败'
    )
    expect(screen.getByRole('alert')).toBeVisible()
  })

  test('does not carry the previous file feedback into a new selection', async () => {
    const user = userEvent.setup()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [
        {
          name: 'main.ts',
          path: '/workspace/project/src/main.ts',
          isDirectory: false,
          size: 24,
          modifiedAt: null,
        },
        {
          name: 'other.ts',
          path: '/workspace/project/src/other.ts',
          isDirectory: false,
          size: 18,
          modifiedAt: null,
        },
      ],
    })
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/src/main.ts',
      name: 'main.ts',
      content: 'export const ready = true',
      editable: false,
      truncated: false,
      size: 24,
      modifiedAt: null,
    })
    const panelProps = {
      target: {
        deviceId: 'workspace-device',
        path: '/workspace/project',
        source: 'project',
        workspaceSource: 'remote',
      },
      workspaceFileApi: { listWorkspaceEntries, readWorkspaceTextFile },
      onAddCodeComment: vi.fn(),
    }

    const { rerender } = render(
      <FileWorkspacePanel
        {...panelProps}
        openFileRequest={{ id: 1, path: '/workspace/project/src/main.ts' }}
      />
    )

    const firstCopyButton = await screen.findByTestId('workspace-file-copy-relative-path-button')
    await user.click(firstCopyButton)
    expect(mockedCopyTextToClipboard).toHaveBeenCalledWith('src/main.ts')
    expect(screen.getByTestId('workspace-file-relative-path-copied-status')).toBeVisible()

    rerender(
      <FileWorkspacePanel
        {...panelProps}
        openFileRequest={{ id: 2, path: '/workspace/project/src/other.ts' }}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('workspace-file-path')).toHaveTextContent(
        '/workspace/project/src/other.ts'
      )
    )
    expect(screen.getByTestId('workspace-file-copy-relative-path-button')).toBeInTheDocument()
    expect(
      screen.queryByTestId('workspace-file-relative-path-copied-status')
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test.each([
    ['/workspace/project', '/workspace/project/src/main.ts', 'src/main.ts'],
    ['C:\\workspace\\project', 'C:\\workspace\\project\\src\\main.ts', 'src/main.ts'],
    ['/', '/README.md', 'README.md'],
    ['/workspace/project/', '/workspace/project/src/main.ts', 'src/main.ts'],
    ['/workspace/project', '/workspace/project', null],
    ['/workspace/project', '/workspace/project/', null],
  ])('resolves %s-relative file paths', (rootPath, filePath, expected) => {
    expect(workspaceRelativeFilePath(rootPath, filePath)).toBe(expected)
  })

  test('rejects paths outside the current workspace root', () => {
    expect(workspaceRelativeFilePath('/workspace/project', '/workspace/other/main.ts')).toBeNull()
  })
})
