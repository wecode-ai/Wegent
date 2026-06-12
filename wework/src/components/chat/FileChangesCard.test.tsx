import '@/i18n'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { TurnFileChangesSummary } from '@/types/api'
import { FileChangesCard } from './FileChangesCard'
import { parseUnifiedDiff } from './parseUnifiedDiff'

const summary: TurnFileChangesSummary = {
  version: 1,
  status: 'active',
  artifact_id: 'turn-8-21',
  device_id: 'device-1',
  workspace_path: '/workspace/project',
  file_count: 6,
  additions: 107,
  deletions: 121,
  files: Array.from({ length: 6 }, (_, index) => ({
    path: `src/file-${index + 1}.ts`,
    change_type: 'modified',
    additions: index + 1,
    deletions: index,
    binary: false,
  })),
}

function renderCard(
  overrides: Partial<{
    summary: TurnFileChangesSummary
    deviceOnline: boolean
    onLoadDiff: (subtaskId: number) => Promise<string>
    onRevert: (subtaskId: number) => Promise<TurnFileChangesSummary>
  }> = {},
) {
  const onLoadDiff =
    overrides.onLoadDiff ??
    vi.fn().mockResolvedValue(
      'diff --git a/src/file-1.ts b/src/file-1.ts\n--- a/src/file-1.ts\n+++ b/src/file-1.ts\n@@ -1 +1 @@\n-old\n+new\n',
    )
  const onRevert =
    overrides.onRevert ??
    vi.fn().mockResolvedValue({ ...summary, status: 'reverted' })

  render(
    <FileChangesCard
      subtaskId={21}
      summary={overrides.summary ?? summary}
      deviceOnline={overrides.deviceOnline ?? true}
      onLoadDiff={onLoadDiff}
      onRevert={onRevert}
    />,
  )
  return { onLoadDiff, onRevert }
}

describe('FileChangesCard', () => {
  test('shows summary and expands files after the first three', async () => {
    renderCard()

    expect(screen.getByText('已编辑 6 个文件')).toBeInTheDocument()
    expect(screen.getByText('+107')).toBeInTheDocument()
    expect(screen.getByText('-121')).toBeInTheDocument()
    expect(screen.getAllByTestId('file-change-row')).toHaveLength(3)

    await userEvent.click(screen.getByTestId('toggle-file-changes-button'))

    expect(screen.getAllByTestId('file-change-row')).toHaveLength(6)
  })

  test('loads diff only when a file row opens', async () => {
    const { onLoadDiff } = renderCard()

    expect(onLoadDiff).not.toHaveBeenCalled()
    await userEvent.click(screen.getByText('src/file-1.ts'))

    await waitFor(() => expect(onLoadDiff).toHaveBeenCalledWith(21))
    const card = screen.getByTestId('file-changes-card')
    expect(
      within(card).getByTestId('inline-file-diff-src/file-1.ts'),
    ).toBeInTheDocument()
    expect(within(card).getByText('old')).toBeInTheDocument()
    expect(within(card).getByText('new')).toBeInTheDocument()
  })

  test('disables review and revert while the owning device is offline', () => {
    renderCard({ deviceOnline: false })

    expect(screen.getAllByTestId('file-change-row')[0]).toBeDisabled()
    expect(screen.getByTestId('revert-file-changes-button')).toBeDisabled()
    expect(
      screen.getByText('设备离线，无法审核或撤销'),
    ).toBeInTheDocument()
  })

  test('confirms before reverting', async () => {
    const { onRevert } = renderCard()

    await userEvent.click(screen.getByTestId('revert-file-changes-button'))
    expect(onRevert).not.toHaveBeenCalled()

    await userEvent.click(
      screen.getByTestId('confirm-revert-file-changes-button'),
    )
    await waitFor(() => expect(onRevert).toHaveBeenCalledWith(21))
  })

  test('shows status without a revert action after a successful revert', () => {
    renderCard({ summary: { ...summary, status: 'reverted' } })

    expect(screen.getByText('已撤销')).toBeInTheDocument()
    expect(
      screen.queryByTestId('revert-file-changes-button'),
    ).not.toBeInTheDocument()
    expect(screen.getAllByTestId('file-change-row')[0]).toBeEnabled()
  })

  test('keeps file diff review available after a revert conflict', () => {
    renderCard({ summary: { ...summary, status: 'conflicted' } })

    expect(
      screen.getByText('存在后续冲突，未修改工作区'),
    ).toBeInTheDocument()
    expect(screen.getAllByTestId('file-change-row')[0]).toBeEnabled()
    expect(
      screen.queryByTestId('revert-file-changes-button'),
    ).not.toBeInTheDocument()
  })

  test('labels binary files without line counts', () => {
    renderCard({
      summary: {
        ...summary,
        file_count: 1,
        additions: 0,
        deletions: 0,
        files: [
          {
            path: 'assets/logo.png',
            change_type: 'modified',
            additions: 0,
            deletions: 0,
            binary: true,
          },
        ],
      },
    })

    expect(screen.getByText('二进制文件')).toBeInTheDocument()
  })
})

describe('parseUnifiedDiff', () => {
  test('groups unified diff by file', () => {
    expect(
      parseUnifiedDiff(
        'diff --git a/a.ts b/a.ts\n+one\ndiff --git a/b.ts b/b.ts\n-two',
      ),
    ).toEqual([
      {
        oldPath: 'a.ts',
        path: 'a.ts',
        lines: ['diff --git a/a.ts b/a.ts', '+one'],
      },
      {
        oldPath: 'b.ts',
        path: 'b.ts',
        lines: ['diff --git a/b.ts b/b.ts', '-two'],
      },
    ])
  })

  test('supports quoted file paths with spaces', () => {
    expect(
      parseUnifiedDiff(
        'diff --git "a/src/file one.ts" "b/src/file one.ts"\n+one',
      )[0],
    ).toMatchObject({
      oldPath: 'src/file one.ts',
      path: 'src/file one.ts',
    })
  })
})
