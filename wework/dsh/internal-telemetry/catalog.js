import catalogDefinition from './catalog/smart-app-events.json' with { type: 'json' }

export const INTERNAL_TELEMETRY_CATALOG_VERSION = 1

const ALLOWED_PROPERTY_NAMES = new Set(['domain', 'failure_stage'])
const ENUM_PROPERTY_TYPE = 'enum'

export function createEventCatalog(definition = catalogDefinition) {
  assertObject(definition, 'catalog definition')
  if (definition.catalogVersion !== INTERNAL_TELEMETRY_CATALOG_VERSION) {
    throw new Error(`catalogVersion must be ${INTERNAL_TELEMETRY_CATALOG_VERSION}`)
  }
  if (!Array.isArray(definition.events) || definition.events.length === 0) {
    throw new Error('events must not be empty')
  }

  const events = new Map()
  for (const definitionEvent of definition.events) {
    const event = createEvent(definitionEvent)
    if (events.has(event.name)) throw new Error(`duplicate event name: ${event.name}`)
    events.set(event.name, event)
  }

  return Object.freeze({
    version: definition.catalogVersion,
    event(name) {
      return events.get(name) ?? null
    },
    eventNames() {
      return [...events.keys()]
    },
  })
}

function createEvent(definition) {
  assertObject(definition, 'event')
  assertNonEmptyString(definition.name, 'event name')
  if (definition.eventSchemaVersion !== INTERNAL_TELEMETRY_CATALOG_VERSION) {
    throw new Error(`eventSchemaVersion must be ${INTERNAL_TELEMETRY_CATALOG_VERSION}`)
  }
  if (typeof definition.includeSmartAppIdentity !== 'boolean') {
    throw new Error('includeSmartAppIdentity must be a boolean')
  }

  const properties = createProperties(definition.properties)
  const domain = properties.domain
  if (!domain || domain.type !== ENUM_PROPERTY_TYPE || domain.values.join(',') !== 'smart_app') {
    throw new Error('domain must be the smart_app enum')
  }

  return Object.freeze({
    name: definition.name,
    eventSchemaVersion: definition.eventSchemaVersion,
    properties,
    includeSmartAppIdentity: definition.includeSmartAppIdentity,
  })
}

function createProperties(definition) {
  assertObject(definition, 'properties')

  const properties = {}
  for (const [name, property] of Object.entries(definition)) {
    if (!ALLOWED_PROPERTY_NAMES.has(name)) throw new Error(`unknown property name: ${name}`)
    assertObject(property, `${name} property`)
    if (property.type !== ENUM_PROPERTY_TYPE) {
      throw new Error(`unknown property type: ${property.type}`)
    }
    if (!Array.isArray(property.values) || property.values.length === 0) {
      throw new Error('enum values must not be empty')
    }
    for (const value of property.values) assertNonEmptyString(value, 'enum value')

    properties[name] = Object.freeze({
      type: property.type,
      values: Object.freeze([...property.values]),
    })
  }

  return Object.freeze(properties)
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`)
  }
}

export const eventCatalog = createEventCatalog()
