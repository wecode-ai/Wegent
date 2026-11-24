import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  captureWindowActivationSnapshot,
  formatWindowActivationLine,
  logWindowActivation,
  noteWindowActivationRequest,
  redactUrl,
  takeCorrelatedActivationRequest,
} from './window-activation-diagnostics.js'

const fakeElectron = {
  app: {
    isActive: () => true,
    isHidden: () => false,
    dock: { isVisible: () => true },
  },
  BrowserWindow: { getFocusedWindow: () => ({ id: 3 }) },
}

describe('redactUrl', () => {
  test('keeps query keys and redacts every query value and the fragment', () => {
    expect(redactUrl('https://example.com/p?a=1&b=two#secret-fragment')).toBe(
      'https://example.com/p?a=*&b=*#*'
    )
  })

  test('preserves non-special scheme paths such as task deep links', () => {
    expect(redactUrl('wework://tasks/local:device/task-1')).toBe(
      'wework://tasks/local:device/task-1'
    )
  })

  test('flattens control characters and caps the length of unparseable input', () => {
    const raw = `not-a-url\n${'x'.repeat(400)}`
    const redacted = redactUrl(raw)
    expect(redacted).not.toContain('\n')
    expect(redacted.length).toBeLessThanOrEqual(320)
  })
})

describe('formatWindowActivationLine', () => {
  const before = captureWindowActivationSnapshot(fakeElectron, {
    id: 9,
    isDestroyed: () => false,
    isVisible: () => false,
    isFocused: () => false,
  })

  test('emits exactly one parseable JSON line with before/after snapshots', () => {
    const line = formatWindowActivationLine(
      {
        reason: 'workspace-open',
        initiator: 'user',
        userInitiated: true,
        target: 'workspace-1',
        url: 'https://example.com/p?token=secret-token',
        label: 'multi\nline',
      },
      before,
      { appActive: true, appHidden: false, dockVisible: true, focusedWindowId: 9 }
    )
    expect(line.startsWith('[window-activation] ')).toBe(true)
    expect(line).not.toContain('\n')
    const payload = JSON.parse(line.slice('[window-activation] '.length)) as Record<string, unknown>
    expect(payload.reason).toBe('workspace-open')
    expect(payload.url).toBe('https://example.com/p?token=*')
    expect(payload.appActiveBefore).toBe(true)
    expect(payload.targetFocusedBefore).toBe(false)
    expect(payload.appActiveAfter).toBe(true)
    expect(payload.focusedWindowIdAfter).toBe(9)
  })

  test('omits fields that are not provided', () => {
    const line = formatWindowActivationLine(
      { reason: 'did-become-active', initiator: 'external_or_user', userInitiated: null },
      { appActive: true, appHidden: null, dockVisible: null, focusedWindowId: null }
    )
    const payload = JSON.parse(line.slice('[window-activation] '.length)) as Record<string, unknown>
    expect(payload.userInitiated).toBeNull()
    expect(payload.url).toBeUndefined()
    expect(payload.appActiveAfter).toBeUndefined()
  })
})

describe('activation request correlation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('returns the newest request once and null afterwards', () => {
    const correlationId = noteWindowActivationRequest()
    expect(takeCorrelatedActivationRequest()).toBe(correlationId)
    expect(takeCorrelatedActivationRequest()).toBeNull()
  })

  test('expires requests outside the correlation window', () => {
    noteWindowActivationRequest()
    vi.advanceTimersByTime(6000)
    expect(takeCorrelatedActivationRequest()).toBeNull()
  })
})

describe('logWindowActivation', () => {
  test('emits a single console line and never throws on hostile payloads', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const hostile = {
      toString: () => {
        throw new Error('boom')
      },
    } as unknown as string
    expect(() =>
      logWindowActivation(
        { reason: 'browser-open', initiator: 'agent', userInitiated: false, url: hostile },
        { appActive: true, appHidden: null, dockVisible: null, focusedWindowId: null }
      )
    ).not.toThrow()
    expect(info).not.toHaveBeenCalled()
    info.mockRestore()
  })
})
