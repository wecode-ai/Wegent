import { expect, test, vi } from 'vitest'
import { createDownloadInactivityTimeout } from './download-timeout.js'

test('permits a progressing download beyond five minutes', () => {
  vi.useFakeTimers()
  try {
    const timeout = createDownloadInactivityTimeout(60_000)
    for (let chunk = 0; chunk < 10; chunk += 1) {
      vi.advanceTimersByTime(40_000)
      expect(timeout.signal.aborted).toBe(false)
      timeout.refresh()
    }
    timeout.clear()
  } finally {
    vi.useRealTimers()
  }
})

test('renews and clears the download inactivity timeout', () => {
  vi.useFakeTimers()
  try {
    const timeout = createDownloadInactivityTimeout(30)
    vi.advanceTimersByTime(20)
    timeout.refresh()
    vi.advanceTimersByTime(20)
    expect(timeout.signal.aborted).toBe(false)
    vi.advanceTimersByTime(10)
    expect(timeout.signal.aborted).toBe(true)

    const completed = createDownloadInactivityTimeout(1)
    completed.clear()
    vi.advanceTimersByTime(1)
    expect(completed.signal.aborted).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})
