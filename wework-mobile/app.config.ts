import type { ConfigContext, ExpoConfig } from 'expo/config'
import { resolveMobileTelemetryBuildConfig } from './telemetryBuildConfig'

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? 'WeWork',
  slug: config.slug ?? 'wework-mobile',
  extra: {
    ...config.extra,
    weworkTelemetry: resolveMobileTelemetryBuildConfig(process.env),
  },
})
