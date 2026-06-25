import '@/i18n'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { TurnFileChangesSummary } from '@/types/api'
import { FileChangesCard } from './FileChangesCard'
import { parseUnifiedDiff } from './parseUnifiedDiff'

type OpenReviewRequest = Parameters<
  NonNullable<Parameters<typeof FileChangesCard>[0]['onOpenReview']>
>[0]

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
    onOpenReview: (request: OpenReviewRequest) => void
  }> = {}
) {
  const onLoadDiff =
    overrides.onLoadDiff ??
    vi
      .fn()
      .mockResolvedValue(
        'diff --git a/src/file-1.ts b/src/file-1.ts\n--- a/src/file-1.ts\n+++ b/src/file-1.ts\n@@ -1 +1 @@\n-old\n+new\n'
      )
  const onRevert =
    overrides.onRevert ?? vi.fn().mockResolvedValue({ ...summary, status: 'reverted' })
  const onOpenReview = overrides.onOpenReview ?? vi.fn()

  render(
    <FileChangesCard
      subtaskId={21}
      summary={overrides.summary ?? summary}
      deviceOnline={overrides.deviceOnline ?? true}
      onLoadDiff={onLoadDiff}
      onRevert={onRevert}
      onOpenReview={onOpenReview}
    />
  )
  return { onLoadDiff, onRevert, onOpenReview }
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

  test('renders file rows instead of inline diff preview when summary contains a diff', () => {
    renderCard({
      summary: {
        ...summary,
        file_count: 2,
        additions: 6,
        deletions: 4,
        files: [
          {
            path: 'wework/src/components/layout/DesktopWorkbenchMain.tsx',
            change_type: 'modified',
            additions: 3,
            deletions: 2,
            binary: false,
          },
          {
            path: 'wework/src/components/layout/MobileWorkbenchLayout.tsx',
            change_type: 'modified',
            additions: 3,
            deletions: 2,
            binary: false,
          },
        ],
        diff: [
          'diff --git a/wework/src/components/layout/DesktopWorkbenchMain.tsx b/wework/src/components/layout/DesktopWorkbenchMain.tsx',
          '--- a/wework/src/components/layout/DesktopWorkbenchMain.tsx',
          '+++ b/wework/src/components/layout/DesktopWorkbenchMain.tsx',
          '@@ -1 +1 @@',
          '-const name = "old"',
          '+const name = "new"',
          'diff --git a/wework/src/components/layout/MobileWorkbenchLayout.tsx b/wework/src/components/layout/MobileWorkbenchLayout.tsx',
          '--- a/wework/src/components/layout/MobileWorkbenchLayout.tsx',
          '+++ b/wework/src/components/layout/MobileWorkbenchLayout.tsx',
          '@@ -1 +1 @@',
          '-const mobile = "old"',
          '+const mobile = "new"',
        ].join('\n'),
      },
    })

    expect(screen.queryByTestId('file-changes-inline-diff')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('file-change-row')).toHaveLength(2)
    expect(
      screen.getByText('wework/src/components/layout/DesktopWorkbenchMain.tsx')
    ).toBeInTheDocument()
    expect(
      screen.getByText('wework/src/components/layout/MobileWorkbenchLayout.tsx')
    ).toBeInTheDocument()
    expect(screen.queryByText('-const name = "old"')).not.toBeInTheDocument()
    expect(screen.queryByText('+const mobile = "new"')).not.toBeInTheDocument()
  })

  test('requests the right review panel without loading diff immediately', async () => {
    const { onLoadDiff, onOpenReview } = renderCard()

    expect(onLoadDiff).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('review-file-changes-button'))

    expect(onOpenReview).toHaveBeenCalledTimes(1)
    const request = vi.mocked(onOpenReview).mock.calls[0][0]
    expect(request.subtaskId).toBe(21)
    expect(request.reviewTitle).toMatch(/Previous turn|上轮对话/)
    expect(request.defaultFileTreeVisible).toBe(false)
    expect(request.focusFilePath).toBeUndefined()
    expect(request.loadDiff).toEqual(expect.any(Function))
    expect(onLoadDiff).not.toHaveBeenCalled()

    await request.loadDiff()
    await waitFor(() => expect(onLoadDiff).toHaveBeenCalledWith(21))
  })

  test('opens the shared review panel when a file row is clicked', async () => {
    const { onLoadDiff, onOpenReview } = renderCard({
      onLoadDiff: vi
        .fn()
        .mockResolvedValue(
          [
            'diff --git a/src/file-1.ts b/src/file-1.ts',
            '--- a/src/file-1.ts',
            '+++ b/src/file-1.ts',
            '@@ -1 +1 @@',
            '-old one',
            '+new one',
            'diff --git a/src/file-2.ts b/src/file-2.ts',
            '--- a/src/file-2.ts',
            '+++ b/src/file-2.ts',
            '@@ -1 +1 @@',
            '-old two',
            '+new two',
          ].join('\n')
        ),
    })

    await userEvent.click(screen.getAllByTestId('file-change-row')[1])

    expect(onOpenReview).toHaveBeenCalledTimes(1)
    const request = vi.mocked(onOpenReview).mock.calls[0][0]
    expect(request.subtaskId).toBe(21)
    expect(request.reviewTitle).toMatch(/Previous turn|上轮对话/)
    expect(request.defaultFileTreeVisible).toBe(false)
    expect(request.focusFilePath).toBe('src/file-2.ts')
    expect(onLoadDiff).not.toHaveBeenCalled()

    await request.loadDiff()
    await waitFor(() => expect(onLoadDiff).toHaveBeenCalledWith(21))
  })

  test('disables review and revert while the owning device is offline', () => {
    renderCard({ deviceOnline: false })

    expect(screen.getByTestId('review-file-changes-button')).toBeDisabled()
    expect(screen.getByTestId('revert-file-changes-button')).toBeDisabled()
    expect(screen.getByText('设备离线，无法审核或撤销')).toBeInTheDocument()
  })

  test('confirms before reverting', async () => {
    const { onRevert } = renderCard()

    await userEvent.click(screen.getByTestId('revert-file-changes-button'))
    expect(onRevert).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('confirm-revert-file-changes-button'))
    await waitFor(() => expect(onRevert).toHaveBeenCalledWith(21))
  })

  test('shows status without a revert action after a successful revert', () => {
    renderCard({ summary: { ...summary, status: 'reverted' } })

    expect(screen.getByText('已撤销')).toBeInTheDocument()
    expect(screen.queryByTestId('revert-file-changes-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('review-file-changes-button')).toBeEnabled()
  })

  test('keeps review available after a revert conflict', () => {
    renderCard({ summary: { ...summary, status: 'conflicted' } })

    expect(screen.getByText('存在后续冲突，未修改工作区')).toBeInTheDocument()
    expect(screen.getByTestId('review-file-changes-button')).toBeEnabled()
    expect(screen.queryByTestId('revert-file-changes-button')).not.toBeInTheDocument()
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
      parseUnifiedDiff('diff --git a/a.ts b/a.ts\n+one\ndiff --git a/b.ts b/b.ts\n-two')
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
      parseUnifiedDiff('diff --git "a/src/file one.ts" "b/src/file one.ts"\n+one')[0]
    ).toMatchObject({
      oldPath: 'src/file one.ts',
      path: 'src/file one.ts',
    })
  })
})
