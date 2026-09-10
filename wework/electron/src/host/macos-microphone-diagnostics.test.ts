import { describe, expect, it, vi } from 'vitest'
import {
  readMacosMicrophoneChecks,
  type MicrophoneDiagnosticCommand,
} from './macos-microphone-diagnostics.js'

const executable = '/Applications/WeWork Test.app/Contents/MacOS/WeWork Test'
const helper = '/Applications/WeWork Test.app/Contents/Frameworks/WeWork Test Helper.app'
const success = (stdout = '', stderr = '') => ({ stdout, stderr, succeeded: true })
const failed = (stderr = '') => ({ stdout: '', stderr, succeeded: false })

function nativeFixture(overrides: Partial<Record<string, ReturnType<typeof success>>> = {}) {
  return vi.fn<MicrophoneDiagnosticCommand>(async (file, args, input) => {
    const key =
      file === '/usr/bin/codesign'
        ? args.at(-1)!
        : file === '/usr/bin/plutil'
          ? (input ?? args.at(-1)!)
          : file
    if (key in overrides) return overrides[key]!
    if (file === '/usr/sbin/ioreg') return success('"AppleClamshellState" = Yes')
    if (file === '/usr/sbin/sysctl') return success('1\n')
    if (file === '/usr/bin/codesign')
      return success('entitlements', 'CodeDirectory v=20500 flags=0x10002(adhoc,runtime)')
    if (input === 'entitlements')
      return success(JSON.stringify({ 'com.apple.security.device.audio-input': true }))
    if (args.at(-1)?.endsWith('/Info.plist'))
      return success(
        JSON.stringify({
          CFBundleName: 'WeWork Test',
          NSMicrophoneUsageDescription: 'Record audio',
        })
      )
    throw new Error(`Unexpected diagnostic command: ${file}`)
  })
}

describe('native macOS microphone evidence', () => {
  it('reads permission, lid, hardware and both signatures without prompting or recording', async () => {
    const command = nativeFixture()
    const permission = vi.fn(() => 'granted')
    const checks = await readMacosMicrophoneChecks({ executable, command, permission })
    expect(checks).toEqual({
      permission: 'granted',
      lidState: 'closed',
      hardwareDisconnectSupported: true,
      appSignature: { hardenedRuntime: true, audioInputEntitlement: true },
      audioHelperSignature: { hardenedRuntime: true, audioInputEntitlement: true },
      usageDescriptionPresent: true,
    })
    expect(permission).toHaveBeenCalledTimes(1)
    expect(
      command.mock.calls
        .filter(([file]) => file === '/usr/bin/codesign')
        .map(([, args]) => args.at(-1))
    ).toEqual([executable, helper])
    expect(new Set(command.mock.calls.map(([file]) => file))).toEqual(
      new Set(['/usr/sbin/ioreg', '/usr/sbin/sysctl', '/usr/bin/plutil', '/usr/bin/codesign'])
    )
  })

  it.each([
    [success('"AppleClamshellState" = No'), 'open'],
    [success(''), 'not-present'],
    [success('malformed output'), 'unknown'],
    [failed('probe timeout'), 'unknown'],
  ] as const)(
    'keeps missing and unreadable lid evidence distinct: %s',
    async (result, expected) => {
      const checks = await readMacosMicrophoneChecks({
        executable,
        command: nativeFixture({ '/usr/sbin/ioreg': result }),
        permission: () => 'granted',
      })
      expect(checks.lidState).toBe(expected)
    }
  )

  it('does not infer hardware support for Intel or unreadable sysctl', async () => {
    for (const result of [success('0'), failed('unknown oid')]) {
      const checks = await readMacosMicrophoneChecks({
        executable,
        command: nativeFixture({ '/usr/sbin/sysctl': result }),
        permission: () => 'granted',
      })
      expect(checks.hardwareDisconnectSupported).toBeNull()
    }
  })

  it('distinguishes confirmed missing entitlement from a failed helper probe', async () => {
    const command = nativeFixture({
      [executable]: success('', 'flags=0x10000(runtime)'),
      [helper]: failed('No such file or directory'),
    })
    const checks = await readMacosMicrophoneChecks({
      executable,
      command,
      permission: () => 'granted',
    })
    expect(checks.appSignature).toEqual({ hardenedRuntime: true, audioInputEntitlement: false })
    expect(checks.audioHelperSignature).toEqual({
      hardenedRuntime: null,
      audioInputEntitlement: null,
    })
  })

  it('marks unreadable entitlements unknown while retaining known runtime flags', async () => {
    const checks = await readMacosMicrophoneChecks({
      executable,
      command: nativeFixture({ entitlements: success('invalid json') }),
      permission: () => 'unexpected',
    })
    expect(checks.permission).toBe('unknown')
    expect(checks.appSignature).toEqual({ hardenedRuntime: true, audioInputEntitlement: null })
  })

  it('detects missing usage description without misidentifying the helper', async () => {
    const command = nativeFixture({
      '/Applications/WeWork Test.app/Contents/Info.plist': success(
        '{"CFBundleName":"WeWork Test"}'
      ),
    })
    const checks = await readMacosMicrophoneChecks({
      executable,
      command,
      permission: () => 'denied',
    })
    expect(checks.usageDescriptionPresent).toBe(false)
    expect(checks.audioHelperSignature.audioInputEntitlement).toBe(true)
  })

  it('returns incomplete evidence when native probes throw', async () => {
    const checks = await readMacosMicrophoneChecks({
      executable,
      command: async () => {
        throw new Error('probe failed')
      },
      permission: () => {
        throw new Error('not available')
      },
    })
    expect(checks).toEqual({
      permission: 'unknown',
      lidState: 'unknown',
      hardwareDisconnectSupported: null,
      appSignature: { hardenedRuntime: null, audioInputEntitlement: null },
      audioHelperSignature: { hardenedRuntime: null, audioInputEntitlement: null },
      usageDescriptionPresent: null,
    })
  })
})
