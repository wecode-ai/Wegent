const HASHED_DISTINCT_ID_PATTERN = /^wework:[0-9a-f]{64}$/
const EMAIL_PREFIX_PATTERN = /^[^\s@]{1,128}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_VALUE_LENGTH = 128
const PLATFORM_VALUES = new Set(['mac', 'win', 'linux'])
const SMART_APP_SOURCE_VALUES = new Set(['managed', 'linked', 'market'])

export function projectEnvelope({ catalog, distinctId, envelope, runtime } = {}) {
  if (!isDistinctId(distinctId)) return rejected('invalid_identity')
  if (!isObject(envelope) || typeof envelope.name !== 'string') return rejected('unknown_event')

  const catalogEvent = catalogEventFor(catalog, envelope.name)
  if (!catalogEvent) return rejected('unknown_event')
  if (!isUuid(envelope.eventId)) return rejected('invalid_event_id')
  if (!isIsoTimestamp(envelope.occurredAt)) return rejected('invalid_occurred_at')
  if (!isRuntime(runtime)) return rejected('invalid_runtime')

  const eventProperties = projectEventProperties(envelope.properties, catalogEvent.properties)
  if (!eventProperties.ok) return eventProperties

  const properties = {
    distinct_id: distinctId,
    $geoip_disable: true,
    ...eventProperties.value,
    event_schema_version: catalogEvent.eventSchemaVersion,
    app_version: runtime.appVersion,
    platform: runtime.platform,
    release_channel: runtime.releaseChannel,
  }

  if (catalogEvent.includeSmartAppIdentity) {
    const smartAppProperties = projectSmartAppProperties(envelope.context?.smartApp)
    if (!smartAppProperties.ok) return smartAppProperties
    Object.assign(properties, smartAppProperties.value)
  }

  return {
    ok: true,
    value: {
      event: catalogEvent.name,
      uuid: envelope.eventId,
      timestamp: envelope.occurredAt,
      properties,
    },
  }
}

function catalogEventFor(catalog, eventName) {
  if (!catalog || typeof catalog.event !== 'function') return null
  try {
    return catalog.event(eventName)
  } catch {
    return null
  }
}

function projectEventProperties(properties, definition) {
  if (!isObject(properties) || !isObject(definition)) return rejected('invalid_property')

  const propertyNames = Object.keys(properties)
  for (const name of propertyNames) {
    if (!Object.hasOwn(definition, name)) return rejected('unknown_property')
  }

  const projected = {}
  for (const [name, property] of Object.entries(definition)) {
    const value = properties[name]
    if (
      !nonEmptyString(value) ||
      !Array.isArray(property.values) ||
      !property.values.includes(value)
    ) {
      return rejected('invalid_property')
    }
    projected[name] = value
  }

  return accepted(projected)
}

function projectSmartAppProperties(smartApp) {
  if (smartApp === undefined) return accepted({})
  if (!isObject(smartApp)) return rejected('invalid_smart_app')

  const { key, name, source, version } = smartApp
  if (
    !boundedString(key) ||
    !boundedString(name) ||
    !boundedString(version) ||
    !SMART_APP_SOURCE_VALUES.has(source)
  ) {
    return rejected('invalid_smart_app')
  }

  return accepted({
    smart_app_key: key,
    smart_app_name: name,
    smart_app_version: version,
    smart_app_source: source,
  })
}

function isRuntime(runtime) {
  return (
    isObject(runtime) &&
    boundedString(runtime.appVersion) &&
    boundedString(runtime.releaseChannel) &&
    PLATFORM_VALUES.has(runtime.platform)
  )
}

function isDistinctId(value) {
  return (
    typeof value === 'string' &&
    (HASHED_DISTINCT_ID_PATTERN.test(value) || EMAIL_PREFIX_PATTERN.test(value))
  )
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function boundedString(value) {
  return nonEmptyString(value) && value.length <= MAX_VALUE_LENGTH
}

function accepted(value) {
  return { ok: true, value }
}

function rejected(reason) {
  return { ok: false, reason }
}
