import { describe, expect, it, vi } from 'vitest'
import { HostCapabilityRouter } from './capability-router.js'
import {
  microphoneDiagnosticResult,
  registerMicrophoneDiagnostics,
  unknownMicrophoneChecks,
} from './microphone-diagnostics.js'

function healthyChecks() {
  return {
    ...unknownMicrophoneChecks(),
    permission: 'granted' as const,
    lidState: 'open' as const,
    hardwareDisconnectSupported: true,
    appSignature: { hardenedRuntime: true, audioInputEntitlement: true },
    audioHelperSignature: { hardenedRuntime: true, audioInputEntitlement: true },
    usageDescriptionPresent: true,
  }
}

describe('microphone diagnostic policy', () => {
  it('does not claim that healthy host checks prove audio capture', () => {
    expect(microphoneDiagnosticResult(healthyChecks(), 'unknown', 'darwin')).toMatchObject({
      schemaVersion: 1,
      status: 'ok',
      code: 'MICROPHONE_NO_KNOWN_BLOCKER',
      issues: [],
    })
  })

  it.each([
    ['denied', 'blocked', 'MICROPHONE_PERMISSION_DENIED', 'open_microphone_settings'],
    ['restricted', 'blocked', 'MICROPHONE_PERMISSION_RESTRICTED', 'contact_administrator'],
    [
      'not-determined',
      'warning',
      'MICROPHONE_PERMISSION_NOT_DETERMINED',
      'request_microphone_access',
    ],
  ] as const)('reports %s without requesting access', (permission, status, code, action) => {
    const result = microphoneDiagnosticResult(
      { ...healthyChecks(), permission },
      'unknown',
      'darwin'
    )
    expect(result).toMatchObject({ status, code, issues: [{ code, actions: [action] }] })
  })

  it.each([
    ['built-in', true, 'blocked', 'MICROPHONE_BUILT_IN_DISABLED_LID_CLOSED'],
    ['unknown', true, 'warning', 'MICROPHONE_LID_CLOSED'],
    ['built-in', null, 'warning', 'MICROPHONE_LID_CLOSED'],
    ['external', true, 'ok', 'MICROPHONE_NO_KNOWN_BLOCKER'],
  ] as const)(
    'handles a closed lid with %s input and hardware support %s',
    (kind, supported, status, code) => {
      const checks = {
        ...healthyChecks(),
        lidState: 'closed' as const,
        hardwareDisconnectSupported: supported,
      }
      expect(microphoneDiagnosticResult(checks, kind, 'darwin')).toMatchObject({ status, code })
    }
  )

  it('retains simultaneous failures and prioritizes errors over warnings', () => {
    const checks = {
      ...healthyChecks(),
      permission: 'denied' as const,
      lidState: 'closed' as const,
      appSignature: { hardenedRuntime: true, audioInputEntitlement: false },
      audioHelperSignature: { hardenedRuntime: true, audioInputEntitlement: false },
      usageDescriptionPresent: false,
    }
    const result = microphoneDiagnosticResult(checks, 'unknown', 'darwin')
    expect(result.status).toBe('blocked')
    expect(result.code).toBe('MICROPHONE_APP_ENTITLEMENT_MISSING')
    expect(result.issues.map(issue => issue.code)).toEqual([
      'MICROPHONE_APP_ENTITLEMENT_MISSING',
      'MICROPHONE_HELPER_ENTITLEMENT_MISSING',
      'MICROPHONE_USAGE_DESCRIPTION_MISSING',
      'MICROPHONE_PERMISSION_DENIED',
      'MICROPHONE_LID_CLOSED',
    ])
  })

  it('does not diagnose absent Hardened Runtime entitlements as a blocker when runtime is disabled', () => {
    const signature = { hardenedRuntime: false, audioInputEntitlement: false }
    expect(
      microphoneDiagnosticResult(
        { ...healthyChecks(), appSignature: signature, audioHelperSignature: signature },
        'unknown',
        'darwin'
      ).status
    ).toBe('ok')
  })

  it('reports unreadable evidence as unknown, never as missing entitlement or success', () => {
    expect(
      microphoneDiagnosticResult(unknownMicrophoneChecks(), 'unknown', 'darwin')
    ).toMatchObject({
      status: 'unknown',
      code: 'MICROPHONE_DIAGNOSTICS_INCOMPLETE',
    })
  })
})

describe('microphone diagnostic capability', () => {
  it('enforces grants and rejects invalid input before reading native state', async () => {
    const router = new HostCapabilityRouter()
    const read = vi.fn(async () => healthyChecks())
    registerMicrophoneDiagnostics(router, read, 'darwin')
    await expect(
      router.invoke('untrusted', 'deviceDiagnostics.microphone', {})
    ).rejects.toMatchObject({ code: 'capability_denied' })
    router.grant('dsh', ['deviceDiagnostics.microphone'])
    for (const inputDeviceKind of [null, 1, {}, 'default', '../built-in']) {
      await expect(
        router.invoke('dsh', 'deviceDiagnostics.microphone', { inputDeviceKind })
      ).rejects.toMatchObject({ code: 'invalid_params' })
    }
    expect(read).not.toHaveBeenCalled()
    await expect(router.invoke('dsh', 'deviceDiagnostics.microphone', {})).resolves.toMatchObject({
      inputDeviceKind: 'unknown',
      status: 'ok',
    })
  })

  it('reads current evidence again so opening the lid recovers without restarting', async () => {
    const router = new HostCapabilityRouter()
    const read = vi
      .fn()
      .mockResolvedValueOnce({ ...healthyChecks(), lidState: 'closed' })
      .mockResolvedValueOnce(healthyChecks())
    registerMicrophoneDiagnostics(router, read, 'darwin')
    router.grant('dsh', ['deviceDiagnostics.microphone'])
    await expect(
      router.invoke('dsh', 'deviceDiagnostics.microphone', { inputDeviceKind: 'built-in' })
    ).resolves.toMatchObject({ status: 'blocked' })
    await expect(
      router.invoke('dsh', 'deviceDiagnostics.microphone', { inputDeviceKind: 'built-in' })
    ).resolves.toMatchObject({ status: 'ok' })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it.each(['win32', 'linux'])('does not execute macOS commands on %s', async platform => {
    const router = new HostCapabilityRouter()
    const read = vi.fn()
    registerMicrophoneDiagnostics(router, read, platform)
    router.grant('dsh', ['deviceDiagnostics.microphone'])
    await expect(router.invoke('dsh', 'deviceDiagnostics.microphone', {})).resolves.toMatchObject({
      platform,
      status: 'unsupported',
      code: 'MICROPHONE_DIAGNOSTICS_UNSUPPORTED',
    })
    expect(read).not.toHaveBeenCalled()
  })
})
