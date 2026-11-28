import { telemetrySampleBucket } from './sampling'

export interface MobileTelemetryState {
  version: 1
  consentAsked: boolean
  consentEnabled: boolean
  installationId: string | null
  installedAt: number | null
  sampleBucket: number | null
  lastSeenAppVersion: string | null
  launchCount: number
  foregroundStartedAt: number | null
  foregroundHeartbeatAt: number | null
}

export interface MobileTelemetryStateStorage {
  read(): Promise<string | null>
  write(value: string): Promise<void>
  quarantine?(): Promise<void>
}

export interface LaunchPreparation {
  state: MobileTelemetryState
  isFirstLaunch: boolean
  installationEvent: 'installed' | 'updated' | null
  previousVersion: string | null
  previousForegroundDurationMs: number | null
  sinceInstallMs: number
}

export interface ForegroundEnd {
  state: MobileTelemetryState
  durationMs: number
}

export const EMPTY_MOBILE_TELEMETRY_STATE: MobileTelemetryState = {
  version: 1,
  consentAsked: false,
  consentEnabled: false,
  installationId: null,
  installedAt: null,
  sampleBucket: null,
  lastSeenAppVersion: null,
  launchCount: 0,
  foregroundStartedAt: null,
  foregroundHeartbeatAt: null,
}

const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/

export function parseMobileTelemetryState(raw: string | null): MobileTelemetryState {
  if (raw === null) return { ...EMPTY_MOBILE_TELEMETRY_STATE }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Invalid mobile telemetry state')
  }
  if (!value || typeof value !== 'object') throw new Error('Invalid mobile telemetry state')
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new Error('Unsupported mobile telemetry state version')
  const installationId = nullableString(record.installationId, ID_PATTERN)
  const installedAt = nullableTimestamp(record.installedAt)
  const sampleBucket = nullableNumber(record.sampleBucket, 0, 1)
  const lastSeenAppVersion = nullableString(record.lastSeenAppVersion, VERSION_PATTERN)
  const launchCount = finiteInteger(record.launchCount, 0)
  const foregroundStartedAt = nullableTimestamp(record.foregroundStartedAt)
  const foregroundHeartbeatAt = nullableTimestamp(record.foregroundHeartbeatAt)
  return {
    version: 1,
    consentAsked: booleanValue(record.consentAsked),
    consentEnabled: booleanValue(record.consentEnabled),
    installationId,
    installedAt,
    sampleBucket,
    lastSeenAppVersion,
    launchCount,
    foregroundStartedAt,
    foregroundHeartbeatAt,
  }
}

export function serializeMobileTelemetryState(state: MobileTelemetryState): string {
  return `${JSON.stringify(state)}\n`
}

export function prepareLaunch(
  state: MobileTelemetryState,
  appVersion: string,
  now: number,
  makeInstallationId: () => string
): LaunchPreparation {
  const isFirstLaunch = state.installationId === null
  const installationId = state.installationId ?? validNewInstallationId(makeInstallationId())
  const installedAt = state.installedAt ?? now
  const sampleBucket = state.sampleBucket ?? telemetrySampleBucket(installationId)
  const previousVersion = state.lastSeenAppVersion
  const previousForegroundDurationMs =
    state.foregroundStartedAt === null
      ? null
      : Math.max(
          0,
          (state.foregroundHeartbeatAt ?? state.foregroundStartedAt) - state.foregroundStartedAt
        )
  const installationEvent = isFirstLaunch
    ? 'installed'
    : previousVersion && previousVersion !== appVersion
      ? 'updated'
      : null
  return {
    state: {
      ...state,
      installationId,
      installedAt,
      sampleBucket,
      lastSeenAppVersion: appVersion,
      launchCount: state.launchCount + 1,
      foregroundStartedAt: now,
      foregroundHeartbeatAt: now,
    },
    isFirstLaunch,
    installationEvent,
    previousVersion,
    previousForegroundDurationMs,
    sinceInstallMs: Math.max(0, now - installedAt),
  }
}

export function beginForeground(state: MobileTelemetryState, now: number): MobileTelemetryState {
  return {
    ...state,
    foregroundStartedAt: now,
    foregroundHeartbeatAt: now,
  }
}

export function endForeground(state: MobileTelemetryState, now: number): ForegroundEnd | null {
  if (state.foregroundStartedAt === null) return null
  const durationMs = Math.max(0, now - state.foregroundStartedAt)
  return {
    state: clearForeground(state),
    durationMs,
  }
}

export function heartbeatForeground(
  state: MobileTelemetryState,
  now: number
): MobileTelemetryState {
  if (state.foregroundStartedAt === null) return state
  return { ...state, foregroundHeartbeatAt: Math.max(state.foregroundHeartbeatAt ?? 0, now) }
}

export function clearForeground(state: MobileTelemetryState): MobileTelemetryState {
  return {
    ...state,
    foregroundStartedAt: null,
    foregroundHeartbeatAt: null,
  }
}

export function resetTelemetryIdentity(state: MobileTelemetryState): MobileTelemetryState {
  return {
    ...clearForeground(state),
    installationId: null,
    installedAt: null,
    sampleBucket: null,
    lastSeenAppVersion: null,
    launchCount: 0,
  }
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid mobile telemetry state field')
  return value
}

function nullableString(value: unknown, pattern: RegExp): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error('Invalid mobile telemetry state field')
  }
  return value
}

function nullableTimestamp(value: unknown): number | null {
  if (value === null) return null
  return finiteInteger(value, 0)
}

function nullableNumber(value: unknown, min: number, max: number): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error('Invalid mobile telemetry state field')
  }
  return value
}

function finiteInteger(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new Error('Invalid mobile telemetry state field')
  }
  return value
}

function validNewInstallationId(value: string): string {
  if (!ID_PATTERN.test(value)) throw new Error('Invalid telemetry installation identifier')
  return value
}
