import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ProcessFileChangesBlockItem,
  ToolDurationText,
} from '../../../../packages/collaboration/src/conversation/blocks/ToolFileChanges'
import { ConversationTranslationProvider } from '../../../../packages/collaboration/src/conversation/ConversationTranslation'
import { createCollaborationTranslator } from '../../../../packages/collaboration/src/i18n'
import type { ProcessingBlock } from '../../../../packages/collaboration/src/conversation/blocks/types'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function fileBlock(
  additions: number,
  id = 'stream-one'
): Extract<ProcessingBlock, { type: 'file_changes' }> {
  return {
    id,
    subtaskId: 1,
    type: 'file_changes',
    status: 'streaming',
    createdAt: 10_000,
    fileChanges: {
      version: 1,
      status: 'active',
      artifact_id: id,
      device_id: 'device-one',
      workspace_path: '/workspace',
      file_count: 1,
      additions,
      deletions: 0,
      files: [{ path: 'file.ts', change_type: 'modified', additions, deletions: 0, binary: false }],
      reverted_at: null,
      revertible: false,
      diff: '',
    },
  }
}

function FileSummary({ block }: { block: Extract<ProcessingBlock, { type: 'file_changes' }> }) {
  return (
    <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
      <ProcessFileChangesBlockItem block={block} />
    </ConversationTranslationProvider>
  )
}

it('freezes duration at the actual stop time between clock ticks', () => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  const { rerender } = render(
    <ToolDurationText startedAt={0} fallbackEndAt={undefined} isRunning />
  )
  expect(screen.getByText('10.0s')).toBeInTheDocument()
  vi.setSystemTime(10_540)
  rerender(<ToolDurationText startedAt={0} fallbackEndAt={undefined} isRunning={false} />)
  expect(screen.getByText('10.5s')).toBeInTheDocument()
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(5_000))
  expect(screen.getByText('10.5s')).toBeInTheDocument()
})

it('keeps the initial running start anchor and uses explicit final timestamps when available', () => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  const { rerender } = render(
    <ToolDurationText startedAt={0} fallbackEndAt={undefined} isRunning />
  )
  rerender(<ToolDurationText startedAt={2_000} fallbackEndAt={undefined} isRunning />)
  expect(screen.getByText('10.0s')).toBeInTheDocument()
  rerender(<ToolDurationText startedAt={2_000} fallbackEndAt={3_000} isRunning={false} />)
  expect(screen.getByText('1.0s')).toBeInTheDocument()
})

it('replaces rapid number animations and clears native animation work on unmount', () => {
  vi.useFakeTimers()
  const { container, rerender, unmount } = render(<FileSummary block={fileBlock(1)} />)
  rerender(<FileSummary block={fileBlock(4)} />)
  act(() => vi.advanceTimersByTime(20))
  expect(container.querySelector('.file-change-delta-badge')).toHaveTextContent('+3')
  rerender(<FileSummary block={fileBlock(6)} />)
  act(() => vi.advanceTimersByTime(20))
  expect(container.querySelector('.file-change-delta-badge')).toHaveTextContent('+2')
  act(() => vi.advanceTimersByTime(560))
  expect(container.querySelector('.file-change-delta-badge')).toBeNull()
  rerender(<FileSummary block={fileBlock(7)} />)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('caps running change history and resets it for a new stream', () => {
  vi.useFakeTimers()
  const { container, rerender } = render(<FileSummary block={fileBlock(1)} />)
  for (let additions = 2; additions <= 10; additions++) {
    rerender(<FileSummary block={fileBlock(additions)} />)
  }
  expect(container.querySelectorAll('.file-change-stat-block')).toHaveLength(6)
  rerender(<FileSummary block={fileBlock(1, 'stream-two')} />)
  expect(container.querySelectorAll('.file-change-stat-block')).toHaveLength(1)
  expect(container.querySelector('.file-change-delta-badge')).toBeNull()
})
