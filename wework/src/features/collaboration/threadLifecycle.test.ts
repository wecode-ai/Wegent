import { describe, expect, it } from 'vitest'
import { threadLifecycleLabel } from './threadLifecycle'

describe('Group lifecycle facts', () => {
  it('distinguishes successive status changes using the authoritative event status', () => {
    expect(
      threadLifecycleLabel({ event_type: 'status_changed', thread_status: 'in_progress' }, 'zh-CN')
    ).toEqual({ key: 'changedEventTo', status: '进行中' })
    expect(
      threadLifecycleLabel({ event_type: 'status_changed', thread_status: 'in_review' }, 'zh-CN')
    ).toEqual({ key: 'changedEventTo', status: '待确认' })
    expect(
      threadLifecycleLabel({ event_type: 'status_changed', thread_status: 'pending' }, 'en')
    ).toEqual({ key: 'changedEventTo', status: 'To do' })
  })

  it('keeps explicit creation, completion and reopening labels', () => {
    expect(
      threadLifecycleLabel({ event_type: 'created', thread_status: 'completed' }, 'zh-CN')
    ).toEqual({ key: 'createdEvent' })
    expect(
      threadLifecycleLabel({ event_type: 'status_changed', thread_status: 'completed' }, 'zh-CN')
    ).toEqual({ key: 'completedEvent' })
    expect(threadLifecycleLabel({ event_type: 'reopened' }, 'zh-CN')).toEqual({
      key: 'reopenedEvent',
    })
  })

  it('does not invent a target for old or unrecognized event metadata', () => {
    expect(threadLifecycleLabel({ event_type: 'status_changed' }, 'zh-CN')).toEqual({
      key: 'changedEvent',
    })
    expect(
      threadLifecycleLabel(
        { event_type: 'status_changed', thread_status: 'old-custom-state' },
        'zh-CN'
      )
    ).toEqual({ key: 'changedEvent' })
  })
})
