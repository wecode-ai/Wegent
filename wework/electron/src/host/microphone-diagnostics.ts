import type {
  MicrophoneDiagnosticAction,
  MicrophoneDiagnosticChecks,
  MicrophoneDiagnosticCode,
  MicrophoneDiagnosticIssue,
  MicrophoneDiagnosticResult,
  MicrophoneInputDeviceKind,
} from '../../../dsh/electron-host/device-diagnostics.js'
import { HostCapabilityError, type HostCapabilityRouter } from './capability-router.js'

export type MicrophoneChecksReader = () => Promise<MicrophoneDiagnosticChecks>

export function microphoneInputDeviceKind(
  params: Record<string, unknown>
): MicrophoneInputDeviceKind {
  const kind = params.inputDeviceKind
  if (kind === undefined) return 'unknown'
  if (kind === 'built-in' || kind === 'external' || kind === 'unknown') return kind
  throw new HostCapabilityError(
    'invalid_params',
    'inputDeviceKind must be built-in, external, or unknown'
  )
}

export function registerMicrophoneDiagnostics(
  router: HostCapabilityRouter,
  readChecks: MicrophoneChecksReader,
  platform: string = process.platform
): void {
  router.register('deviceDiagnostics.microphone', async params => {
    const kind = microphoneInputDeviceKind(params)
    const checks = platform === 'darwin' ? await readChecks() : unknownMicrophoneChecks()
    return microphoneDiagnosticResult(checks, kind, platform)
  })
}

export function unknownMicrophoneChecks(): MicrophoneDiagnosticChecks {
  return {
    permission: 'unknown',
    lidState: 'unknown',
    hardwareDisconnectSupported: null,
    appSignature: { hardenedRuntime: null, audioInputEntitlement: null },
    audioHelperSignature: { hardenedRuntime: null, audioInputEntitlement: null },
    usageDescriptionPresent: null,
  }
}

export function microphoneDiagnosticResult(
  checks: MicrophoneDiagnosticChecks,
  inputDeviceKind: MicrophoneInputDeviceKind,
  platform: string
): MicrophoneDiagnosticResult {
  const issues = platform === 'darwin' ? microphoneIssues(checks, inputDeviceKind) : []
  const primary =
    issues.find(issue => issue.severity === 'error') ??
    issues.find(issue => issue.severity === 'warning') ??
    issues[0]
  const status =
    platform !== 'darwin'
      ? 'unsupported'
      : primary?.severity === 'error'
        ? 'blocked'
        : primary?.severity === 'warning'
          ? 'warning'
          : primary
            ? 'unknown'
            : 'ok'
  return {
    schemaVersion: 1,
    platform,
    checkedAt: new Date().toISOString(),
    status,
    code:
      platform !== 'darwin'
        ? 'MICROPHONE_DIAGNOSTICS_UNSUPPORTED'
        : (primary?.code ?? 'MICROPHONE_NO_KNOWN_BLOCKER'),
    issues,
    inputDeviceKind,
    checks,
  }
}

function microphoneIssues(
  checks: MicrophoneDiagnosticChecks,
  kind: MicrophoneInputDeviceKind
): MicrophoneDiagnosticIssue[] {
  const issues: MicrophoneDiagnosticIssue[] = []
  const add = (
    code: MicrophoneDiagnosticCode,
    severity: MicrophoneDiagnosticIssue['severity'],
    actions: MicrophoneDiagnosticAction[]
  ) => issues.push({ code, severity, actions })
  signingIssues(checks).forEach(issue => issues.push(issue))
  if (checks.permission === 'denied')
    add('MICROPHONE_PERMISSION_DENIED', 'error', ['open_microphone_settings'])
  if (checks.permission === 'restricted')
    add('MICROPHONE_PERMISSION_RESTRICTED', 'error', ['contact_administrator'])
  if (checks.permission === 'not-determined')
    add('MICROPHONE_PERMISSION_NOT_DETERMINED', 'warning', ['request_microphone_access'])
  if (checks.lidState === 'closed' && kind !== 'external') {
    const disabled = kind === 'built-in' && checks.hardwareDisconnectSupported === true
    add(
      disabled ? 'MICROPHONE_BUILT_IN_DISABLED_LID_CLOSED' : 'MICROPHONE_LID_CLOSED',
      disabled ? 'error' : 'warning',
      ['open_lid', 'select_external_microphone']
    )
  }
  if (checksIncomplete(checks))
    add('MICROPHONE_DIAGNOSTICS_INCOMPLETE', 'info', ['retry_diagnostics'])
  return issues
}

function signingIssues(checks: MicrophoneDiagnosticChecks): MicrophoneDiagnosticIssue[] {
  const issues: MicrophoneDiagnosticIssue[] = []
  const signatures = [
    ['MICROPHONE_APP_ENTITLEMENT_MISSING', checks.appSignature],
    ['MICROPHONE_HELPER_ENTITLEMENT_MISSING', checks.audioHelperSignature],
  ] as const
  for (const [code, signature] of signatures) {
    if (signature.hardenedRuntime === true && signature.audioInputEntitlement === false) {
      issues.push({ code, severity: 'error', actions: ['update_application'] })
    }
  }
  if (checks.usageDescriptionPresent === false) {
    issues.push({
      code: 'MICROPHONE_USAGE_DESCRIPTION_MISSING',
      severity: 'error',
      actions: ['update_application'],
    })
  }
  return issues
}

function checksIncomplete(checks: MicrophoneDiagnosticChecks): boolean {
  return (
    checks.permission === 'unknown' ||
    checks.lidState === 'unknown' ||
    checks.usageDescriptionPresent === null ||
    [checks.appSignature, checks.audioHelperSignature].some(
      signature =>
        signature.hardenedRuntime === null ||
        (signature.hardenedRuntime && signature.audioInputEntitlement === null)
    )
  )
}
