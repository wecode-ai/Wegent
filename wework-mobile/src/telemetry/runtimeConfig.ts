import Constants from 'expo-constants'
import { Platform } from 'react-native'
import {
  mobileTelemetryAvailable,
  parseMobileTelemetryBuildConfig,
  type MobileTelemetryConfig,
} from './config'

const MAX_VERSION_LENGTH = 64

function boundedVersion(value: unknown): string {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  return text ? text.slice(0, MAX_VERSION_LENGTH) : 'unknown'
}

export function getMobileTelemetryConfig(): MobileTelemetryConfig {
  const extra = Constants.expoConfig?.extra as { weworkTelemetry?: unknown } | undefined
  const build = parseMobileTelemetryBuildConfig(extra?.weworkTelemetry)
  return {
    ...build,
    available: mobileTelemetryAvailable(build),
    appVersion: boundedVersion(Constants.expoConfig?.version),
    appBuild: boundedVersion(
      Platform.OS === 'ios'
        ? Constants.expoConfig?.ios?.buildNumber
        : Constants.expoConfig?.android?.versionCode
    ),
    platform: boundedLabel(Platform.OS),
    osVersion: boundedVersion(String(Platform.Version ?? '')),
    locale: deviceLocale(),
  }
}

function deviceLocale(): string {
  try {
    return boundedVersion(Intl.DateTimeFormat().resolvedOptions().locale)
  } catch {
    return 'unknown'
  }
}

function boundedLabel(value: string): string {
  return /^[A-Za-z0-9._-]{1,32}$/.test(value) ? value : 'unknown'
}
