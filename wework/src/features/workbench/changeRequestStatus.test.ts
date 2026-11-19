// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { createInstance } from 'i18next'
import zh from '@/i18n/locales/zh-CN/common.json'
import en from '@/i18n/locales/en/common.json'
import type { ChangeRequest } from '@/types/environment'
import {
  autoRepairStatus,
  buildChangeRequestRepairPrompt,
  changeRequestRepairEventKey,
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
  it.each([
    [{ state: 'merged' as const, checks: 'failure' as const }, 'merged'],
    [{ state: 'closed' as const, checks: 'success' as const }, 'closed'],
    [{ mergeStateStatus: 'dirty' as const, checks: 'failure' as const }, 'merge_conflict'],
    [{ checks: 'failure' as const, mergeQueue: 'failed' as const }, 'checks_failed'],
    [{ mergeQueue: 'failed' as const }, 'merge_queue_failed'],
    [{ mergeQueue: 'timed_out' as const }, 'merge_queue_timed_out'],
    [{ mergeQueue: 'unmergeable' as const }, 'merge_queue_unmergeable'],
    [{ reviewDecision: 'review_required' as const, draft: true }, 'blocked'],
    [{ draft: true }, 'draft'],
    [{ checks: 'pending' as const }, 'checks_pending'],
    [{ mergeQueue: 'awaiting_checks' as const }, 'merge_queue_checking'],
    [{ mergeQueue: 'queued' as const }, 'merge_queue_queued'],
    [{ mergeQueue: 'locked' as const }, 'merge_queue_locked'],
    [{ mergeQueue: 'mergeable' as const }, 'checks_passed'],
    [
      { mergeQueue: 'removed' as const, mergeStateStatus: 'behind' as const },
      'merge_queue_removed',
    ],
    [{ mergeQueue: 'removed' as const }, 'merge_queue_removed'],
    [{ mergeStateStatus: 'behind' as const }, 'behind'],
    [{ mergeStateStatus: 'unstable' as const }, 'unstable'],
    [{ mergeStateStatus: 'has_hooks' as const }, 'has_hooks'],
    [{ mergeStateStatus: 'clean' as const }, 'checks_passed'],
    [{ mergeStateStatus: 'unknown' as const }, 'checks_passed'],
    [{ mergeStateStatus: 'unknown' as const, mergeability: 'unknown' as const }, 'open'],
  ])('projects %j as %s using the shared precedence', (patch, expected) => {
    expect(changeRequestVisualStatus({ ...pullRequest, ...patch })).toBe(expected)
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

  it('maps unmergeable queue entries onto the existing auto-repair contract', () => {
    const unmergeable = { ...pullRequest, mergeQueue: 'unmergeable' as const }

    expect(changeRequestVisualStatus(unmergeable)).toBe('merge_queue_unmergeable')
    expect(autoRepairStatus(unmergeable)).toBe('merge_queue_conflicting')
  })

  it('keeps the repair event key stable when a delayed head SHA arrives', () => {
    expect(changeRequestRepairEventKey({ ...pullRequest, headSha: 'abc123' })).toBe(
      changeRequestRepairEventKey(pullRequest)
    )
  })

  it('only keeps a stopped task visible while its PR remains open', () => {
    expect(stoppedTaskNeedsAttention(pullRequest)).toBe(true)
    expect(stoppedTaskNeedsAttention({ ...pullRequest, state: 'closed' })).toBe(false)
    expect(stoppedTaskNeedsAttention({ ...pullRequest, state: 'merged' })).toBe(false)
    expect(stoppedTaskNeedsAttention(null)).toBe(false)
  })

  it('builds a continuation prompt that keeps the existing PR', async () => {
    const i18n = createInstance()
    await i18n.init({ lng: 'zh-CN', resources: { 'zh-CN': { common: zh } } })
    const prompt = buildChangeRequestRepairPrompt(
      { ...pullRequest, mergeQueue: 'timed_out', mergeQueueReason: 'Checks timed out' },
      '修复 MQ',
      i18n.getFixedT('zh-CN', 'common'),
      '不要通过重试隐藏问题'
    )

    expect(prompt).toContain('继续当前任务“修复 MQ”')
    expect(prompt).toContain('Checks timed out')
    expect(prompt).toContain('不要创建重复 PR/MR')
    expect(prompt).toContain('不要通过重试隐藏问题')
  })

  it.each(['zh-CN', 'en'])(
    'uses human-readable %s status instead of internal codes',
    async language => {
      const i18n = createInstance()
      await i18n.init({ lng: language, resources: { 'zh-CN': { common: zh }, en: { common: en } } })
      const t = i18n.getFixedT(language, 'common')
      const prompt = buildChangeRequestRepairPrompt(
        { ...pullRequest, checks: 'failure' },
        'Fix CI',
        t
      )
      expect(prompt).toContain(t('workbench.change_request_status_checks_failed'))
      expect(prompt).not.toContain('checks_failed')
      expect(prompt).not.toContain('合并问题')
    }
  )
})
