// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Tooltip } from '../issue-detail/Tooltip'
import { useEffect, useState } from 'react'
import type { CollaborationExecutionEnvironment } from '../types'
import type { PlatformMessages } from './platformMessages'

export function useDeviceLastSeenClock(enabled: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [enabled])
  return now
}

export function deviceLastSeenLabel(
  device: Pick<CollaborationExecutionEnvironment, 'status' | 'last_seen_at'>,
  locale: string,
  messages: PlatformMessages,
  now: number,
): { label: string; timestamp?: string; full?: string } {
  const timestamp = device.last_seen_at ?? ''
  const date = new Date(timestamp)
  const valid = Boolean(timestamp) && Number.isFinite(date.getTime())
  if (!valid)
    return {
      label:
        device.status === 'online'
          ? messages.currentlyOnline
          : messages.lastSeenUnknown,
    }
  const minutes = Math.floor(Math.max(0, now - date.getTime()) / 60_000)
  const unit = minutes >= 1440 ? 'day' : minutes >= 60 ? 'hour' : 'minute'
  const value =
    unit === 'day'
      ? Math.floor(minutes / 1440)
      : unit === 'hour'
        ? Math.floor(minutes / 60)
        : minutes
  return {
    label:
      device.status === 'online'
        ? messages.currentlyOnline
        : minutes === 0
          ? messages.justNow
          : new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
              -value,
              unit,
            ),
    timestamp,
    full: new Intl.DateTimeFormat(locale, {
      dateStyle: 'full',
      timeStyle: 'long',
    }).format(date),
  }
}

export function DeviceLastSeen({
  device,
  locale,
  messages,
  now,
}: {
  device: CollaborationExecutionEnvironment
  locale: string
  messages: PlatformMessages
  now: number
}) {
  const seen = deviceLastSeenLabel(device, locale, messages, now)
  return (
    <span
      className="collaboration-device-last-seen"
      data-testid={`collaboration-device-last-seen-${device.id}`}
    >
      {seen.full ? (
        <Tooltip label={seen.full}>
          <time dateTime={seen.timestamp} tabIndex={0}>
            {seen.label}
          </time>
        </Tooltip>
      ) : (
        seen.label
      )}
    </span>
  )
}
