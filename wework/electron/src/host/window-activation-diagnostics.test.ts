import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  captureWindowActivationSnapshotSafe,
  formatWindowActivationLine,
  logWindowActivationForElectron,
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

  test('redacts userinfo credentials', () => {
    expect(redactUrl('wework://user:secret@host/path?token=abc')).toBe(
      'wework://redacted:redacted@host/path?token=*'
    )
  })

  test('redacts the opaque requestKey of interaction deep links', () => {
    expect(redactUrl('wework://interactions/dev-1/task-9/request-abc')).toBe(
      'wework://interactions/dev-1/task-9/*'
    )
    expect(redactUrl('wework://tasks/local:device/task-1')).toBe(
      'wework://tasks/local:device/task-1'
    )
  })

  test('returns a fixed marker for unparseable URLs without echoing input', () => {
    const redacted = redactUrl('not-a-url?token=secret-token&session=abc#frag')
    expect(redacted).toBe('[invalid-url]')
  })

  test('caps the length of a long valid URL', () => {
    const redacted = redactUrl(`https://example.com/${'a'.repeat(400)}?q=1`)
    expect(redacted.length).toBeLessThanOrEqual(320)
    expect(redacted.startsWith('https://example.com/')).toBe(true)
  })

  test('treats non-darwin platforms as unknown activity without calling app.isActive', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const throwingElectron = {
        app: {
          isActive: () => {
            throw new Error('darwin only')
          },
        },
        BrowserWindow: { getFocusedWindow: () => null },
      }
      const snapshot = captureWindowActivationSnapshotSafe(throwingElectron)
      expect(snapshot?.appActive).toBeNull()
      expect(snapshot?.appHidden).toBeNull()
      expect(snapshot?.dockVisible).toBeNull()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})

describe('formatWindowActivationLine', () => {
  test('emits exactly one parseable JSON line with before/after snapshots', () => {
    // The snapshot semantics under test are the darwin ones; force the
    // platform explicitly so CI on linux runs the same branch.
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const before = captureWindowActivationSnapshotSafe(fakeElectron, {
      id: 9,
      isDestroyed: () => false,
      isVisible: () => false,
      isFocused: () => false,
    })
    try {
      const line = formatWindowActivationLine(
        {
          reason: 'workspace-open',
          initiator: 'user',
          userInitiated: true,
          target: 'workspace-1',
          url: 'https://example.com/p?token=secret-token',
          label: 'multi\nline',
          agentStatus: 'needs_user',
        },
        before,
        { appActive: true, appHidden: false, dockVisible: true, focusedWindowId: 9 }
      )
      expect(line.startsWith('[window-activation] ')).toBe(true)
      expect(line).not.toContain('\n')
      const payload = JSON.parse(line.slice('[window-activation] '.length)) as Record<
        string,
        unknown
      >
      expect(payload.reason).toBe('workspace-open')
      expect(payload.url).toBe('https://example.com/p?token=*')
      expect(payload.appActiveBefore).toBe(true)
      expect(payload.targetFocusedBefore).toBe(false)
      expect(payload.agentStatus).toBe('needs_user')
      expect(payload.appActiveAfter).toBe(true)
      expect(payload.focusedWindowIdAfter).toBe(9)
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  test('omits fields that are not provided, including missing snapshots', () => {
    const line = formatWindowActivationLine({
      reason: 'did-become-active',
      initiator: 'agent',
      userInitiated: false,
      activationOutcome: 'requested',
      requestedReason: 'popout-show',
    })
    const payload = JSON.parse(line.slice('[window-activation] '.length)) as Record<string, unknown>
    expect(payload.activationOutcome).toBe('requested')
    expect(payload.requestedReason).toBe('popout-show')
    expect(payload.appActiveBefore).toBeUndefined()
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

  test('returns the newest request with its origin once and null afterwards', () => {
    const correlationId = noteWindowActivationRequest({
      reason: 'popout-show',
      initiator: 'user',
      userInitiated: true,
      target: 'popout',
    })
    const pending = takeCorrelatedActivationRequest()
    expect(pending?.correlationId).toBe(correlationId)
    expect(pending?.reason).toBe('popout-show')
    expect(pending?.initiator).toBe('user')
    expect(pending?.userInitiated).toBe(true)
    expect(pending?.target).toBe('popout')
    expect(takeCorrelatedActivationRequest()).toBeNull()
  })

  test('expires requests outside the correlation window', () => {
    noteWindowActivationRequest({ reason: 'popout-show', initiator: 'user', userInitiated: true })
    vi.advanceTimersByTime(6000)
    expect(takeCorrelatedActivationRequest()).toBeNull()
  })
})

describe('diagnostics safety boundary', () => {
  test('a throwing Electron accessor leaves the snapshot undefined on darwin', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      const throwingElectron = {
        app: {
          isActive: () => {
            throw new Error('boom')
          },
        },
        BrowserWindow: { getFocusedWindow: () => null },
      }
      expect(captureWindowActivationSnapshotSafe(throwingElectron)).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  test('capture, format, and console failures never reach the caller', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const hostile = {
      toString: () => {
        throw new Error('boom')
      },
    } as unknown as string
    expect(() =>
      logWindowActivationForElectron(
        { reason: 'browser-open', initiator: 'agent', userInitiated: false, url: hostile },
        fakeElectron
      )
    ).not.toThrow()
    expect(info).not.toHaveBeenCalled()
    info.mockRestore()
  })
})
