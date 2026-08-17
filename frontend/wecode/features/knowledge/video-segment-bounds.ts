// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface VideoSegmentBounds {
  startSec: number
  endSec: number
  duration: number
}

const VIDEO_DURATION_TOLERANCE_SECONDS = 2

export function resolveVideoSegmentBounds(
  segment: { start_sec: number; end_sec: number },
  mediaDuration?: number
): VideoSegmentBounds | null {
  if (segment.start_sec < 0 || segment.end_sec <= segment.start_sec) return null
  const hasMediaDuration =
    mediaDuration !== undefined && Number.isFinite(mediaDuration) && mediaDuration > 0
  if (hasMediaDuration && segment.start_sec >= mediaDuration) return null
  if (hasMediaDuration && segment.end_sec > mediaDuration + VIDEO_DURATION_TOLERANCE_SECONDS) {
    return null
  }
  const endSec = hasMediaDuration ? Math.min(segment.end_sec, mediaDuration) : segment.end_sec
  if (endSec <= segment.start_sec) return null
  return { startSec: segment.start_sec, endSec, duration: endSec - segment.start_sec }
}
