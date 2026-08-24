import { describe, expect, it } from 'vitest'
import type { ChangeRequest } from '@/types/environment'
import {
  autoRepairStatus,
  buildChangeRequestRepairPrompt,
  changeRequestVisualStatus,
  stoppedTaskNeedsAttention,
} from './changeRequestStatus'

const pullRequest: ChangeRequest = {
  provider: 'github',
  number: 48,
  url: 'https://github.com/wecode-ai/Wegent/pull/48',
  title: 'Fix merge queue',
  state: 'open',
  draft: false,
  checks: 'success',
  mergeability: 'mergeable',
  mergeQueue: 'not_queued',
  headBranch: 'feature/fix',
}

describe('changeRequestStatus', () => {
  it('uses draft as the canonical status before checks', () => {
    expect(
      changeRequestVisualStatus({
        ...pullRequest,
        draft: true,
        checks: 'success',
      })
    ).toBe('draft')
  })

  it('prioritizes merge queue failure over successful PR checks', () => {
    const failed = {
      ...pullRequest,
      mergeQueue: 'failed' as const,
      mergeQueueReason: 'Required status check failed',
    }

    expect(changeRequestVisualStatus(failed)).toBe('merge_queue_failed')
    expect(autoRepairStatus(failed)).toBe('merge_queue_failed')
  })

  it('only keeps a stopped task visible while its PR remains open', () => {
    expect(stoppedTaskNeedsAttention(pullRequest)).toBe(true)
    expect(stoppedTaskNeedsAttention({ ...pullRequest, state: 'closed' })).toBe(false)
    expect(stoppedTaskNeedsAttention({ ...pullRequest, state: 'merged' })).toBe(false)
    expect(stoppedTaskNeedsAttention(null)).toBe(false)
  })

  it('builds a continuation prompt that keeps the existing PR', () => {
    const prompt = buildChangeRequestRepairPrompt(
      { ...pullRequest, mergeQueue: 'timed_out', mergeQueueReason: 'Checks timed out' },
      '修复 MQ',
      '不要通过重试隐藏问题'
    )

    expect(prompt).toContain('继续当前任务“修复 MQ”')
    expect(prompt).toContain('Checks timed out')
    expect(prompt).toContain('不要创建重复 PR/MR')
    expect(prompt).toContain('不要通过重试隐藏问题')
  })
})
