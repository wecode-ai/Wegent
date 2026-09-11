export type MicrophoneInputDeviceKind = 'built-in' | 'external' | 'unknown'

export interface MicrophoneDiagnosticOptions {
  /** The selected input's known transport, supplied by the caller; omit when unknown. */
  readonly inputDeviceKind?: MicrophoneInputDeviceKind
}

export type MicrophoneDiagnosticCode =
  | 'MICROPHONE_PERMISSION_DENIED'
  | 'MICROPHONE_PERMISSION_RESTRICTED'
  | 'MICROPHONE_PERMISSION_NOT_DETERMINED'
  | 'MICROPHONE_APP_ENTITLEMENT_MISSING'
  | 'MICROPHONE_HELPER_ENTITLEMENT_MISSING'
  | 'MICROPHONE_USAGE_DESCRIPTION_MISSING'
  | 'MICROPHONE_BUILT_IN_DISABLED_LID_CLOSED'
  | 'MICROPHONE_LID_CLOSED'
  | 'MICROPHONE_DIAGNOSTICS_INCOMPLETE'
  | 'MICROPHONE_DIAGNOSTICS_UNSUPPORTED'
  | 'MICROPHONE_NO_KNOWN_BLOCKER'

export type MicrophoneDiagnosticAction =
  | 'open_lid'
  | 'select_external_microphone'
  | 'open_microphone_settings'
  | 'request_microphone_access'
  | 'contact_administrator'
  | 'update_application'
  | 'retry_diagnostics'

export interface MicrophoneDiagnosticIssue {
  readonly code: MicrophoneDiagnosticCode
  readonly severity: 'error' | 'warning' | 'info'
  readonly actions: readonly MicrophoneDiagnosticAction[]
}

export interface MicrophoneSignatureCheck {
  readonly hardenedRuntime: boolean | null
  readonly audioInputEntitlement: boolean | null
}

export interface MicrophoneDiagnosticChecks {
  readonly permission: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'
  readonly lidState: 'open' | 'closed' | 'not-present' | 'unknown'
  /** True only when the host has confirmed hardware microphone cutoff support. */
  readonly hardwareDisconnectSupported: boolean | null
  readonly appSignature: MicrophoneSignatureCheck
  readonly audioHelperSignature: MicrophoneSignatureCheck
  readonly usageDescriptionPresent: boolean | null
}

export interface MicrophoneDiagnosticResult {
  readonly schemaVersion: 1
  readonly platform: string
  readonly checkedAt: string
  /** `ok` means no known host blocker, not successful recording or non-silent audio. */
  readonly status: 'ok' | 'blocked' | 'warning' | 'unknown' | 'unsupported'
  readonly code: MicrophoneDiagnosticCode
  readonly issues: readonly MicrophoneDiagnosticIssue[]
  readonly inputDeviceKind: MicrophoneInputDeviceKind
  readonly checks: MicrophoneDiagnosticChecks
}
