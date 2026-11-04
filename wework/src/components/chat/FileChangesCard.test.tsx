import '@/i18n'
import type { TurnFileChangesSummary } from '@/types/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { FileChangesCard } from './FileChangesCard'

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
    onLoadDiff: (subtaskId: string) => Promise<string>
    onRevert: (subtaskId: string) => Promise<TurnFileChangesSummary>
    onOpenReview: (request: OpenReviewRequest) => void
    diffPreviewDisabled: boolean
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
      subtaskId="21"
      summary={overrides.summary ?? summary}
      deviceOnline={overrides.deviceOnline ?? true}
      onLoadDiff={onLoadDiff}
      onRevert={onRevert}
      onOpenReview={onOpenReview}
      diffPreviewDisabled={overrides.diffPreviewDisabled}
    />
  )
  return { onLoadDiff, onRevert, onOpenReview }
}

describe('FileChangesCard', () => {
  test('disables review and revert while the owning device is offline', () => {
    renderCard({ deviceOnline: false })

    expect(screen.getAllByTestId('review-file-changes-button')[0]).toBeDisabled()
    expect(screen.getAllByTestId('revert-file-changes-button')[0]).toBeDisabled()
    expect(screen.getByText('设备离线，无法审查或撤销')).toBeInTheDocument()
  })

  test('confirms before reverting active file changes', async () => {
    const { onRevert } = renderCard()
    const revertButton = screen.getAllByTestId('revert-file-changes-button')[0]

    expect(revertButton).toBeEnabled()
    await userEvent.click(revertButton)

    expect(onRevert).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('confirm-revert-file-changes-button'))

    await waitFor(() => expect(onRevert).toHaveBeenCalledWith('21', summary))
  })

  test('cancels file change revert without calling the backend', async () => {
    const { onRevert } = renderCard()

    await userEvent.click(screen.getByTestId('revert-file-changes-button'))
    await userEvent.click(screen.getByTestId('cancel-revert-file-changes-button'))

    expect(onRevert).not.toHaveBeenCalled()
    expect(screen.queryByTestId('confirm-revert-file-changes-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('revert-file-changes-button')).toBeEnabled()
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
})
