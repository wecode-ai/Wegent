const MOBILE_TELEMETRY_SOURCE = 'wework-mobile'
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'
const BOUNDED_LABEL = /^[A-Za-z0-9._-]{1,48}$/

function parseTelemetrySampleRate(value) {
  if (value === undefined || value === null || value === '') return 1
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error('WEWORK_TELEMETRY_SAMPLE_RATE must be a number between 0 and 1')
  }
  return parsed
}

function resolveMobileTelemetryBuildConfig(environment) {
  const read = (name, fallback = '') => {
    const explicit = environment[`WEWORK_${name}`]?.trim()
    if (explicit) return explicit
    return environment[`EXPO_PUBLIC_WEWORK_${name}`]?.trim() || fallback
  }
  const releaseChannel = read(
    'RELEASE_CHANNEL',
    environment.EAS_BUILD_PROFILE?.trim() || 'development'
  )
  return {
    posthogHost: read('POSTHOG_HOST', DEFAULT_POSTHOG_HOST),
    posthogKey: read('POSTHOG_KEY'),
    sampleRate: parseTelemetrySampleRate(read('TELEMETRY_SAMPLE_RATE')),
    environment: read(
      'TELEMETRY_ENVIRONMENT',
      releaseChannel === 'stable' || releaseChannel === 'beta'
        ? 'production'
        : environment.EAS_BUILD_PROFILE?.trim() ||
            (environment.NODE_ENV === 'production' ? 'production' : 'development')
    ),
    releaseChannel,
    source: read('TELEMETRY_SOURCE', MOBILE_TELEMETRY_SOURCE),
  }
}

function boundedLabel(value, fallback) {
  return typeof value === 'string' && BOUNDED_LABEL.test(value) ? value : fallback
}

function validHost(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function parseMobileTelemetryBuildConfig(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('Missing mobile telemetry build configuration')
  }
  const posthogHost =
    typeof value.posthogHost === 'string' && value.posthogHost.trim()
      ? value.posthogHost.trim()
      : DEFAULT_POSTHOG_HOST
  if (!validHost(posthogHost)) throw new Error('Invalid PostHog host')
  return {
    posthogHost,
    posthogKey: typeof value.posthogKey === 'string' ? value.posthogKey.trim() : '',
    sampleRate: parseTelemetrySampleRate(value.sampleRate),
    environment: boundedLabel(value.environment, 'development'),
    releaseChannel: boundedLabel(value.releaseChannel, 'development'),
    source: boundedLabel(value.source, MOBILE_TELEMETRY_SOURCE),
  }
}

function mobileTelemetryAvailable(config) {
  return Boolean(config.posthogKey && config.sampleRate > 0 && validHost(config.posthogHost))
}

module.exports = {
  MOBILE_TELEMETRY_SOURCE,
  mobileTelemetryAvailable,
  parseMobileTelemetryBuildConfig,
  parseTelemetrySampleRate,
  resolveMobileTelemetryBuildConfig,
}
