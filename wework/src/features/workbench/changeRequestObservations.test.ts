import { describe, expect, it } from 'vitest'
import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import { changeRequestResourceEventKeys } from './changeRequestObservations'

describe('change request resource event attribution', () => {
  it('claims only failed checks for the same PR and current revision', () => {
    const current = {
      key: 'a'.repeat(64),
      topicId: 'https://github.com/org/repo/pull/1',
      external: { headSha: 'current', objectKind: 'checks', conclusion: 'failure' },
    }
    const snapshot = {
      changeRequest: { url: current.topicId, headSha: 'current', checks: 'failure' },
      resourceEvents: [
        current,
        current,
        { ...current, key: 'b'.repeat(64), external: { ...current.external, headSha: 'old' } },
        { ...current, key: 'c'.repeat(64), topicId: 'https://github.com/org/other/pull/1' },
        {
          ...current,
          key: 'd'.repeat(64),
          external: { ...current.external, conclusion: 'success' },
        },
      ],
    } as TaskChangeRequestSnapshot
    expect(changeRequestResourceEventKeys(snapshot)).toEqual([current.key])
    expect(changeRequestResourceEventKeys({ ...snapshot, changeRequest: null })).toEqual([])
  })
})
