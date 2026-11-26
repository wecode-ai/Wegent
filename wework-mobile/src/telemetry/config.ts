import type { MobileTelemetryBuildConfig } from '../../telemetryBuildConfig'

export {
  MOBILE_TELEMETRY_SOURCE,
  mobileTelemetryAvailable,
  parseMobileTelemetryBuildConfig,
  parseTelemetrySampleRate,
  resolveMobileTelemetryBuildConfig,
} from '../../telemetryBuildConfig'
export type { MobileTelemetryBuildConfig } from '../../telemetryBuildConfig'

export interface MobileTelemetryConfig extends MobileTelemetryBuildConfig {
  available: boolean
  appVersion: string
  appBuild: string
  platform: string
  osVersion: string
  locale: string
}
