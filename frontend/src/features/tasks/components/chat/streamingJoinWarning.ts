// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

const TEN_MINUTES_MS = 10 * 60 * 1000
const TWENTY_MINUTES_MS = 20 * 60 * 1000

type StreamingJoinTiming = {
  started_at?: string | null
  last_activity_at?: string | null
}

function parseTimestampMs(value?: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

export function getStreamingJoinWarningKey(
  timing?: StreamingJoinTiming | null,
  nowMs: number = Date.now()
): string | null {
  if (!timing) return null

  const startedAtMs = parseTimestampMs(timing.started_at)
  const lastActivityAtMs = parseTimestampMs(timing.last_activity_at)
  if (startedAtMs === null) return null

  // Compatibility fallback:
  // If last_activity_at is not available (older backend), only apply
  // the long-running warning based on started_at.
  if (lastActivityAtMs === null) {
    if (nowMs - startedAtMs > TWENTY_MINUTES_MS) {
      return 'chat:streaming_wait.started_over_20m'
    }
    return null
  }

  if (nowMs - lastActivityAtMs > TEN_MINUTES_MS) {
    return 'chat:streaming_wait.stale_update_10m'
  }

  if (nowMs - startedAtMs > TWENTY_MINUTES_MS) {
    return 'chat:streaming_wait.started_over_20m'
  }

  return null
}
