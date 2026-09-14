import { systemPreferences } from 'electron'
import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import type {
  MicrophoneDiagnosticChecks,
  MicrophoneSignatureCheck,
} from '../../../dsh/electron-host/device-diagnostics.js'
import { unknownMicrophoneChecks } from './microphone-diagnostics.js'

interface CommandResult {
  stdout: string
  stderr: string
  succeeded: boolean
}

export type MicrophoneDiagnosticCommand = (
  file: string,
  args: string[],
  input?: string
) => Promise<CommandResult>

interface NativeDiagnosticOptions {
  executable?: string
  command?: MicrophoneDiagnosticCommand
  permission?: () => string
}

/** Read-only probes: no recording, permission requests, shell interpolation, or TCC database access. */
export async function readMacosMicrophoneChecks({
  executable = process.execPath,
  command = runCommand,
  permission = () => systemPreferences.getMediaAccessStatus('microphone'),
}: NativeDiagnosticOptions = {}): Promise<MicrophoneDiagnosticChecks> {
  const [lidState, hardwareDisconnectSupported, signing] = await Promise.all([
    readLidState(command),
    readHardwareDisconnectSupport(command),
    readSigningChecks(executable, command),
  ])
  return {
    permission: readPermission(permission),
    lidState,
    hardwareDisconnectSupported,
    ...signing,
  }
}

function readPermission(read: () => string): MicrophoneDiagnosticChecks['permission'] {
  try {
    const state = read()
    return ['granted', 'denied', 'restricted', 'not-determined'].includes(state)
      ? (state as MicrophoneDiagnosticChecks['permission'])
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function readLidState(
  command: MicrophoneDiagnosticCommand
): Promise<MicrophoneDiagnosticChecks['lidState']> {
  try {
    const result = await command('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'])
    if (!result.succeeded) return 'unknown'
    if (!result.stdout.trim()) return 'not-present'
    const value = result.stdout.match(/"AppleClamshellState"\s*=\s*(Yes|No)\b/)?.[1]
    return value === 'Yes' ? 'closed' : value === 'No' ? 'open' : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function readHardwareDisconnectSupport(
  command: MicrophoneDiagnosticCommand
): Promise<boolean | null> {
  try {
    const result = await command('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'])
    // Apple silicon is confirmed, including under Rosetta. Intel/T2 support is not inferred.
    return result.succeeded && result.stdout.trim() === '1' ? true : null
  } catch {
    return null
  }
}

async function readSigningChecks(executable: string, command: MicrophoneDiagnosticCommand) {
  const unknown = unknownMicrophoneChecks()
  const contents = dirname(dirname(executable))
  const info =
    basename(dirname(executable)) === 'MacOS' && basename(contents) === 'Contents'
      ? await readPlist(command, join(contents, 'Info.plist'))
      : null
  const name = info?.CFBundleName
  const helper =
    typeof name === 'string' && name && basename(name) === name
      ? join(contents, 'Frameworks', `${name} Helper.app`)
      : null
  const [appSignature, audioHelperSignature] = await Promise.all([
    readSignature(command, executable),
    helper ? readSignature(command, helper) : Promise.resolve(unknown.audioHelperSignature),
  ])
  return {
    appSignature,
    audioHelperSignature,
    usageDescriptionPresent:
      info === null
        ? null
        : typeof info.NSMicrophoneUsageDescription === 'string' &&
          Boolean(info.NSMicrophoneUsageDescription.trim()),
  }
}

async function readSignature(
  command: MicrophoneDiagnosticCommand,
  path: string
): Promise<MicrophoneSignatureCheck> {
  const unknown = { hardenedRuntime: null, audioInputEntitlement: null }
  try {
    const result = await command('/usr/bin/codesign', [
      '--display',
      '--verbose=2',
      '--entitlements',
      ':-',
      path,
    ])
    if (!result.succeeded) {
      return result.stderr.includes('code object is not signed at all')
        ? { hardenedRuntime: false, audioInputEntitlement: false }
        : unknown
    }
    const flags = result.stderr.match(/\bflags=0x([0-9a-f]+)/i)?.[1]
    const plist = result.stdout.trim() ? await readPlist(command, '-', result.stdout) : {}
    const value = plist?.['com.apple.security.device.audio-input']
    return {
      hardenedRuntime: flags === undefined ? null : (Number.parseInt(flags, 16) & 0x10000) !== 0,
      audioInputEntitlement:
        plist === null
          ? null
          : value === undefined
            ? false
            : typeof value === 'boolean'
              ? value
              : null,
    }
  } catch {
    return unknown
  }
}

async function readPlist(
  command: MicrophoneDiagnosticCommand,
  path: string,
  input?: string
): Promise<Record<string, unknown> | null> {
  try {
    const result = await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], input)
    if (!result.succeeded) return null
    const value: unknown = JSON.parse(result.stdout)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function runCommand(file: string, args: string[], input?: string): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = execFile(
      file,
      args,
      { encoding: 'utf8', timeout: 2000, maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, succeeded: !error })
      }
    )
    child.stdin?.end(input)
  })
}
