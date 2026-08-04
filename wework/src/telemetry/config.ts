import { getRuntimeConfig } from '@/config/runtime'
import { getPlatform } from '@/lib/platform'
import type { CommonTelemetryProperties } from './events'

const SESSION_ID_KEY = 'wework.telemetry.session-id.v1'

export interface TelemetryConfig {
  environment: string
  posthogHost: string
  posthogKey: string
  releaseChannel: string
  sentryDsn: string
  sentryTracesSampleRate: number
}

function env(name: keyof ImportMetaEnv): string {
  return String(import.meta.env[name] ?? '').trim()
}

function sampleRate(value: string): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.05
}

export function getTelemetryConfig(): TelemetryConfig {
  return {
    environment: env('VITE_WEWORK_TELEMETRY_ENVIRONMENT') || import.meta.env.MODE,
    posthogHost: env('VITE_WEWORK_POSTHOG_HOST') || 'https://us.i.posthog.com',
    posthogKey: env('VITE_WEWORK_POSTHOG_KEY'),
    releaseChannel: env('VITE_WEWORK_RELEASE_CHANNEL') || 'development',
    sentryDsn: env('VITE_WEWORK_SENTRY_DSN'),
    sentryTracesSampleRate: sampleRate(env('VITE_WEWORK_SENTRY_TRACES_SAMPLE_RATE')),
  }
}

function architecture(): CommonTelemetryProperties['arch'] {
  const userAgent = (navigator.userAgent || '').toLowerCase()
  if (userAgent.includes('arm64') || userAgent.includes('aarch64')) return 'arm64'
  if (userAgent.includes('x86_64') || userAgent.includes('win64')) return 'x64'
  return 'unknown'
}

export function getCommonTelemetryProperties(): CommonTelemetryProperties {
  const config = getTelemetryConfig()
  return {
    $geoip_disable: true,
    app_version: __WEWORK_APP_VERSION__,
    arch: architecture(),
    locale: navigator.language || 'unknown',
    os: getPlatform(),
    release_channel: config.releaseChannel,
    runtime_mode: getRuntimeConfig().runtimeMode,
    telemetry_session_id: telemetrySessionId(),
  }
}

export function telemetrySessionId(): string {
  const stored = sessionStorage.getItem(SESSION_ID_KEY)
  if (stored) return stored
  const created = crypto.randomUUID()
  sessionStorage.setItem(SESSION_ID_KEY, created)
  return created
}

export function resetTelemetrySessionId(): void {
  sessionStorage.removeItem(SESSION_ID_KEY)
}
