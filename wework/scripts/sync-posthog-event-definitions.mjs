import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const catalogPath = join(scriptDirectory, '../telemetry/catalog/public-events.json')

export async function syncEventDefinitions({
  apiKey,
  catalog,
  dryRun = false,
  fetchImpl = fetch,
  host,
  projectId,
}) {
  const baseUrl = `${host.replace(/\/$/, '')}/api/projects/${projectId}/event_definitions/`
  const existing = await listAll(baseUrl, apiKey, fetchImpl)
  const definitions = new Map(existing.map(definition => [definition.name, definition]))
  let created = 0
  let updated = 0

  for (const event of catalog.events) {
    const payload = eventPayload(catalog, event)
    const current = definitions.get(event.name)
    if (!current) {
      created += 1
      if (!dryRun) await request(baseUrl, apiKey, fetchImpl, { body: payload, method: 'POST' })
      continue
    }
    if (sameDefinition(current, payload)) continue
    updated += 1
    if (!dryRun) {
      await request(`${baseUrl}${encodeURIComponent(current.id)}/`, apiKey, fetchImpl, {
        body: payload,
        method: 'PATCH',
      })
    }
  }

  return { created, updated }
}

export async function syncPropertyDefinitions({
  apiKey,
  catalog,
  dryRun = false,
  fetchImpl = fetch,
  host,
  log = console.info,
  projectId,
}) {
  const definitionsUrl = `${host.replace(/\/$/, '')}/api/projects/${projectId}/property_definitions/`
  const existing = await listAll(`${definitionsUrl}?type=event`, apiKey, fetchImpl)
  const definitions = new Map(existing.map(definition => [definition.name, definition]))
  let pending = 0
  let updated = 0

  for (const property of publicProperties(catalog)) {
    const current = definitions.get(property.name)
    if (!current) {
      pending += 1
      log(`property pending first event: ${property.name}`)
      continue
    }
    const payload = propertyPayload(catalog, property)
    if (samePropertyDefinition(current, payload)) continue
    updated += 1
    if (!dryRun) {
      await request(`${definitionsUrl}${encodeURIComponent(current.id)}/`, apiKey, fetchImpl, {
        body: payload,
        method: 'PATCH',
      })
    }
  }

  return { pending, updated }
}

export async function syncTelemetryDefinitions(options) {
  const events = await syncEventDefinitions(options)
  const properties = await syncPropertyDefinitions(options)
  return { events, properties }
}

function eventPayload(catalog, event) {
  return {
    default_columns: event.properties.map(property => property.name),
    description: event.description.en,
    name: event.name,
    tags: [...new Set(['wework', catalog.domain, `schema-v${event.eventSchemaVersion}`])],
    verified: true,
  }
}

function sameDefinition(current, expected) {
  return (
    current.description === expected.description &&
    current.verified === expected.verified &&
    sameValues(current.default_columns, expected.default_columns) &&
    sameValues(current.tags, expected.tags)
  )
}

function publicProperties(catalog) {
  const properties = new Map()
  for (const event of catalog.events) {
    for (const property of event.properties) {
      properties.set(property.name, property)
    }
  }
  return [...properties.values()]
}

function propertyPayload(catalog, property) {
  return {
    description: `Public Wework ${catalog.domain} telemetry property: ${property.name}`,
    property_type: postHogPropertyType(property.type),
    tags: [...new Set(['wework', catalog.domain, `schema-v${catalog.schemaVersion}`])],
    verified: true,
  }
}

function postHogPropertyType(type) {
  if (type === 'number') return 'Numeric'
  if (type === 'boolean') return 'Boolean'
  return 'String'
}

function samePropertyDefinition(current, expected) {
  return (
    current.description === expected.description &&
    current.property_type === expected.property_type &&
    current.verified === expected.verified &&
    sameValues(current.tags, expected.tags)
  )
}

function sameValues(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every(value => expected.includes(value))
  )
}

async function listAll(url, apiKey, fetchImpl) {
  const definitions = []
  let next = url
  while (next) {
    const page = await request(next, apiKey, fetchImpl)
    definitions.push(...page.results)
    next = page.next
  }
  return definitions
}

async function request(url, apiKey, fetchImpl, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  })
  if (!response.ok) throw new Error(`PostHog request failed: ${response.status}`)
  return response.json()
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
  const {
    POSTHOG_HOST: host,
    POSTHOG_PERSONAL_API_KEY: apiKey,
    POSTHOG_PROJECT_ID: projectId,
  } = process.env
  if (!host || !apiKey || !projectId) {
    if (!dryRun)
      throw new Error('POSTHOG_HOST, POSTHOG_PROJECT_ID, and POSTHOG_PERSONAL_API_KEY are required')
    console.info(
      `would sync ${catalog.events.length} telemetry event definitions and ${publicProperties(catalog).length} public property definitions (credentials unavailable)`
    )
    return
  }
  const result = await syncTelemetryDefinitions({ apiKey, catalog, dryRun, host, projectId })
  console.info(
    `${dryRun ? 'would sync' : 'synced'} ${result.events.created} created and ${result.events.updated} updated event definitions; ${result.properties.updated} updated and ${result.properties.pending} pending property definitions`
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
