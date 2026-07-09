import '@/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    onLoadDiff: (subtaskId: number, summary?: TurnFileChangesSummary) => Promise<string>
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

    expect(screen.getByTestId('file-changes-summary-title')).toHaveTextContent('已编辑 6 个文件')
    expect(screen.getByTestId('file-changes-card')).toHaveTextContent('+107')
    expect(screen.getByTestId('file-changes-card')).toHaveTextContent('-121')
    expect(screen.getAllByTestId('file-change-row')).toHaveLength(3)
    expect(screen.getByText('src/file-1.ts')).toBeInTheDocument()
    expect(screen.getAllByTestId('file-change-view-label')[0]).toHaveTextContent('查看更改')
    expect(screen.getAllByTestId('file-change-stats-label')[0]).toHaveClass(
      'group-hover/file-change-trigger:hidden'
    )
    expect(screen.getAllByTestId('file-change-view-label')[0]).toHaveClass(
      'hidden',
      'group-hover/file-change-trigger:flex'
    )
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('-0')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('toggle-file-changes-button'))

    expect(screen.getAllByTestId('file-change-row')).toHaveLength(6)
    expect(screen.getByTestId('toggle-file-changes-button')).toHaveTextContent('收起文件')
  })

  test('opens a delayed diff preview from the changed file hover target', () => {
    vi.useFakeTimers()
    try {
      renderCard({
        summary: {
          ...summary,
          file_count: 1,
          additions: 3,
          deletions: 0,
          files: [
            {
              path: 'references/github-pr-flow.md',
              change_type: 'modified',
              additions: 3,
              deletions: 0,
              binary: false,
            },
          ],
          diff: [
            '@@ -24,2 +24,4 @@',
            ' 2. Capture the PR URL and PR number for later notification.',
            '+3. After the PR is created, check whether it has merge conflicts before waiting for checks.',
            '+4. If the PR has merge conflicts, update the task branch from the latest base branch.',
            ' ',
            '@@ -42,2 +44,3 @@',
            ' gh pr create',
            '+gh pr view <pr-url-or-number> --json mergeable,mergeStateStatus,state,url',
            ' gh pr checks <pr-url> --watch',
          ].join('\n'),
        },
      })

      fireEvent.pointerEnter(screen.getByTestId('file-change-trigger'))
      act(() => vi.advanceTimersByTime(499))
      expect(screen.queryByTestId('file-change-diff-preview')).not.toBeInTheDocument()

      act(() => vi.advanceTimersByTime(1))
      const preview = screen.getByTestId('file-change-diff-preview')
      expect(preview).toHaveAttribute('data-placement', 'below')
      expect(preview).toHaveStyle({ width: '640px' })
      expect(preview).toHaveClass('fixed', 'z-[9999]', 'pointer-events-auto', 'select-text')
      expect(preview).not.toHaveClass('pointer-events-none')
      expect(preview.lastElementChild).toHaveClass('max-h-[min(24rem,calc(100vh-9rem))]')
      expect(preview.firstElementChild).toHaveTextContent(
        '/workspace/project/references/github-pr-flow.md'
      )
      expect(preview).toHaveTextContent('+3')
      expect(preview).toHaveTextContent('-0')
      expect(preview).toHaveTextContent('After the PR is created')
      expect(preview).toHaveTextContent('gh pr view <pr-url-or-number>')

      fireEvent.pointerLeave(screen.getByTestId('file-change-trigger'))
      expect(screen.getByTestId('file-change-diff-preview')).toBeInTheDocument()

      fireEvent.pointerDown(preview)
      fireEvent.blur(screen.getByRole('button', { name: /references\/github-pr-flow\.md/ }))
      act(() => vi.advanceTimersByTime(140))
      expect(screen.getByTestId('file-change-diff-preview')).toBeInTheDocument()

      fireEvent.pointerEnter(preview)
      act(() => vi.advanceTimersByTime(140))
      expect(screen.getByTestId('file-change-diff-preview')).toBeInTheDocument()

      fireEvent.pointerLeave(preview)
      act(() => vi.advanceTimersByTime(139))
      expect(screen.getByTestId('file-change-diff-preview')).toBeInTheDocument()

      act(() => vi.advanceTimersByTime(1))
      expect(screen.queryByTestId('file-change-diff-preview')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  test('shows the absolute file path in the diff preview header', () => {
    vi.useFakeTimers()
    try {
      renderCard({
        summary: {
          ...summary,
          file_count: 1,
          additions: 3,
          deletions: 0,
          files: [
            {
              path: '/Users/crystal/dev/git/if/skills/wegent-dev/SKILL.md',
              change_type: 'modified',
              additions: 3,
              deletions: 0,
              binary: false,
            },
          ],
          diff: [
            '@@ -43,2 +43,3 @@',
            ' Previous line',
            '+After creating the PR, check for merge conflicts and resolve them before waiting.',
            ' Next line',
          ].join('\n'),
        },
      })

      fireEvent.pointerEnter(screen.getByTestId('file-change-trigger'))
      act(() => vi.advanceTimersByTime(500))

      const previewHeader = screen.getByTestId('file-change-diff-preview').firstElementChild
      expect(previewHeader).toHaveTextContent(
        '/Users/crystal/dev/git/if/skills/wegent-dev/SKILL.md'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  test('keeps more than the first fourteen diff lines available in the scroll preview', () => {
    vi.useFakeTimers()
    try {
      renderCard({
        summary: {
          ...summary,
          file_count: 1,
          additions: 20,
          deletions: 0,
          files: [
            {
              path: 'executor/src/runtime_work/mod.rs',
              change_type: 'modified',
              additions: 20,
              deletions: 0,
              binary: false,
            },
          ],
          diff: [
            '@@ -1,2 +1,22 @@',
            ' fn demo() {',
            ...Array.from(
              { length: 20 },
              (_, index) => `+    let value_${index + 1} = ${index + 1};`
            ),
            ' }',
          ].join('\n'),
        },
      })

      fireEvent.pointerEnter(screen.getByTestId('file-change-trigger'))
      act(() => vi.advanceTimersByTime(500))

      const preview = screen.getByTestId('file-change-diff-preview')
      expect(preview.firstElementChild).toHaveTextContent(
        '/workspace/project/executor/src/runtime_work/mod.rs'
      )
      expect(preview).toHaveTextContent('let value_1 = 1;')
      expect(preview).toHaveTextContent('let value_20 = 20;')
      expect(preview).not.toHaveTextContent('...')
    } finally {
      vi.useRealTimers()
    }
  })

  test('makes the single-file change summary area open the review panel', () => {
    const { onOpenReview } = renderCard({
      summary: {
        ...summary,
        file_count: 1,
        additions: 2,
        deletions: 0,
        files: [
          {
            path: 'SKILL.md',
            change_type: 'modified',
            additions: 2,
            deletions: 0,
            binary: false,
          },
        ],
      },
    })

    const summaryButton = screen.getByRole('button', {
      name: /SKILL\.md/,
    })
    expect(summaryButton).toHaveClass('h-full', 'w-full')

    fireEvent.click(summaryButton)
    expect(onOpenReview).toHaveBeenCalledTimes(1)
    expect(vi.mocked(onOpenReview).mock.calls[0][0].focusFilePath).toBe('SKILL.md')
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
    expect(
      screen.getByRole('button', {
        name: /wework\/src\/components\/layout\/DesktopWorkbenchMain\.tsx/,
      })
    ).toBeInTheDocument()
    expect(screen.queryByText('-const name = "old"')).not.toBeInTheDocument()
    expect(screen.queryByText('+const mobile = "new"')).not.toBeInTheDocument()
  })

  test('opens a delayed diff preview from a file row in a multi-file summary', () => {
    vi.useFakeTimers()
    try {
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
              path: 'scripts/notify_pr_ready.sh',
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
            'diff --git a/scripts/notify_pr_ready.sh b/scripts/notify_pr_ready.sh',
            '--- a/scripts/notify_pr_ready.sh',
            '+++ b/scripts/notify_pr_ready.sh',
            '@@ -8 +8 @@',
            '-old notify command',
            '+new notify command',
          ].join('\n'),
        },
      })

      fireEvent.pointerEnter(screen.getAllByTestId('file-change-trigger')[1])
      act(() => vi.advanceTimersByTime(500))

      const preview = screen.getByTestId('file-change-diff-preview')
      expect(preview).toHaveTextContent('notify_pr_ready.sh')
      expect(preview).toHaveTextContent('old notify command')
      expect(preview).toHaveTextContent('new notify command')
      expect(preview).not.toHaveTextContent('DesktopWorkbenchMain.tsx')
    } finally {
      vi.useRealTimers()
    }
  })

  test('requests the right review panel without loading diff immediately', async () => {
    const { onLoadDiff, onOpenReview } = renderCard()

    expect(onLoadDiff).not.toHaveBeenCalled()
    await userEvent.click(screen.getAllByTestId('review-file-changes-button')[0])

    expect(onOpenReview).toHaveBeenCalledTimes(1)
    const request = vi.mocked(onOpenReview).mock.calls[0][0]
    expect(request.subtaskId).toBe(21)
    expect(request.reviewTitle).toMatch(/Previous turn|上轮对话/)
    expect(request.defaultFileTreeVisible).toBe(false)
    expect(request.focusFilePath).toBeUndefined()
    expect(request.loadDiff).toEqual(expect.any(Function))
    expect(onLoadDiff).not.toHaveBeenCalled()

    await request.loadDiff()
    await waitFor(() => expect(onLoadDiff).toHaveBeenCalledWith(21, summary))
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

    await userEvent.click(screen.getByRole('button', { name: /src\/file-2\.ts/ }))

    expect(onOpenReview).toHaveBeenCalledTimes(1)
    const request = vi.mocked(onOpenReview).mock.calls[0][0]
    expect(request.subtaskId).toBe(21)
    expect(request.reviewTitle).toMatch(/Previous turn|上轮对话/)
    expect(request.defaultFileTreeVisible).toBe(false)
    expect(request.focusFilePath).toBe('src/file-2.ts')
    expect(onLoadDiff).not.toHaveBeenCalled()

    await request.loadDiff()
    await waitFor(() => expect(onLoadDiff).toHaveBeenCalledWith(21, summary))
  })

  test('disables review and revert while the owning device is offline', () => {
    renderCard({ deviceOnline: false })

    expect(screen.getAllByTestId('review-file-changes-button')[0]).toBeDisabled()
    expect(screen.getAllByTestId('revert-file-changes-button')[0]).toBeDisabled()
    expect(screen.getByText('设备离线，无法审核或撤销')).toBeInTheDocument()
  })

  test('keeps the revert action visible but disabled while revert is unsupported', async () => {
    const { onRevert } = renderCard()
    const revertButton = screen.getAllByTestId('revert-file-changes-button')[0]

    expect(revertButton).toBeDisabled()
    await userEvent.click(revertButton)
    expect(onRevert).not.toHaveBeenCalled()
    expect(screen.queryByTestId('confirm-revert-file-changes-button')).not.toBeInTheDocument()
  })

  test('keeps the revert action visible but disabled when active changes are not revertible', () => {
    renderCard({ summary: { ...summary, revertible: false } })

    expect(screen.getAllByTestId('revert-file-changes-button')[0]).toBeDisabled()
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
    expect(screen.getAllByTestId('review-file-changes-button')[0]).toBeEnabled()
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
