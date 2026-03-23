// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getStreamingJoinWarningKey } from '@/features/tasks/components/chat/streamingJoinWarning'

describe('getStreamingJoinWarningKey', () => {
  const now = new Date('2026-03-20T10:00:00.000Z').getTime()

  it('returns stale-update warning when last activity is over 10 minutes', () => {
    const key = getStreamingJoinWarningKey(
      {
        started_at: '2026-03-20T09:30:00.000Z',
        last_activity_at: '2026-03-20T09:49:00.000Z',
      },
      now
    )

    expect(key).toBe('chat:streaming_wait.stale_update_10m')
  })

  it('returns long-running warning when stream started over 20 minutes', () => {
    const key = getStreamingJoinWarningKey(
      {
        started_at: '2026-03-20T09:39:00.000Z',
        last_activity_at: '2026-03-20T09:59:30.000Z',
      },
      now
    )

    expect(key).toBe('chat:streaming_wait.started_over_20m')
  })

  it('returns stale-update warning first when both conditions match', () => {
    const key = getStreamingJoinWarningKey(
      {
        started_at: '2026-03-20T09:20:00.000Z',
        last_activity_at: '2026-03-20T09:45:00.000Z',
      },
      now
    )

    expect(key).toBe('chat:streaming_wait.stale_update_10m')
  })

  it('returns null when thresholds are not exceeded', () => {
    const key = getStreamingJoinWarningKey(
      {
        started_at: '2026-03-20T09:50:30.000Z',
        last_activity_at: '2026-03-20T09:55:00.000Z',
      },
      now
    )

    expect(key).toBeNull()
  })

  it('does not show 10m stale warning when last_activity_at is missing', () => {
    const key = getStreamingJoinWarningKey(
      {
        started_at: '2026-03-20T09:47:00.000Z',
      },
      now
    )

    expect(key).toBeNull()
  })

  it('falls back to started_at when last_activity_at is missing (>20 min)', () => {
    const key = getStreamingJoinWarningKey(
      {
        started_at: '2026-03-20T09:35:00.000Z',
      },
      now
    )

    expect(key).toBe('chat:streaming_wait.started_over_20m')
  })
})
