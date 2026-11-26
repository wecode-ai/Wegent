export interface MobileTelemetryBuildConfig {
  posthogHost: string
  posthogKey: string
  sampleRate: number
  environment: string
  releaseChannel: string
  source: string
}

export const MOBILE_TELEMETRY_SOURCE: string

export function parseTelemetrySampleRate(value: unknown): number

export function resolveMobileTelemetryBuildConfig(
  environment: Readonly<Record<string, string | undefined>>
): MobileTelemetryBuildConfig

export function parseMobileTelemetryBuildConfig(value: unknown): MobileTelemetryBuildConfig

export function mobileTelemetryAvailable(config: MobileTelemetryBuildConfig): boolean
