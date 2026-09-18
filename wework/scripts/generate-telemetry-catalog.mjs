import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { format, resolveConfig } from 'prettier'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const weworkDirectory = path.resolve(scriptDirectory, '..')
const registryPath = path.join(weworkDirectory, 'src/telemetry/registry/smartAppRegistry.json')
const generatedTypesPath = path.join(weworkDirectory, 'src/telemetry/generated/smartAppEvents.ts')
const publicCatalogJsonPath = path.join(weworkDirectory, 'telemetry/catalog/public-events.json')
const publicCatalogMarkdownPath = path.join(weworkDirectory, 'telemetry/catalog/public-events.md')
const SAFE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/
const SAFE_PROPERTY_NAMES = new Set(['domain', 'failure_stage'])

export function routeEventName(domain, feature) {
  return feature === 'app' ? `${domain}_opened` : `${domain}_${feature}_opened`
}

export function operationEventName(domain, action, outcome) {
  return `${domain}_${action}_${outcome}`
}

export function validateRegistry(registry) {
  assertObject(registry, 'registry')
  assertEqual(registry.schemaVersion, 1, 'schemaVersion must be 1')
  assertSnakeCase(registry.domain, 'domain')
  assertNonEmptyString(registry.owner, 'owner')
  assertArray(registry.routes, 'routes')
  assertArray(registry.operations, 'operations')

  const keys = new Set()
  const eventNames = new Set()

  for (const route of registry.routes) {
    validateEntry(route, 'route', keys)
    assertSnakeCase(route.feature, 'route feature')
    assertObject(route.match, 'route match')
    if (!route.match.pathname && !route.match.pathnamePrefix) {
      throw new Error('route match must define pathname or pathnamePrefix')
    }
    const eventName = routeEventName(registry.domain, route.feature)
    assertUnique(eventNames, eventName, 'duplicate event name')
  }

  for (const operation of registry.operations) {
    validateEntry(operation, 'operation', keys)
    assertSnakeCase(operation.action, 'operation action')
    assertArray(operation.failureStages, 'failureStages')
    if (operation.failureStages.length === 0) {
      throw new Error('failureStages must not be empty')
    }
    for (const stage of operation.failureStages) assertSnakeCase(stage, 'failure stage')
    for (const outcome of ['succeeded', 'failed']) {
      const eventName = operationEventName(registry.domain, operation.action, outcome)
      assertUnique(eventNames, eventName, 'duplicate event name')
    }
  }
}

export function buildCatalog(registry) {
  validateRegistry(registry)
  return {
    schemaVersion: registry.schemaVersion,
    domain: registry.domain,
    owner: registry.owner,
    events: [
      ...registry.routes.map(route => ({
        description: route.description,
        eventSchemaVersion: registry.schemaVersion,
        key: route.key,
        kind: 'route',
        match: route.match,
        name: routeEventName(registry.domain, route.feature),
        properties: route.publicProperties,
        title: route.name,
      })),
      ...registry.operations.flatMap(operation => [
        {
          description: operation.description,
          eventSchemaVersion: registry.schemaVersion,
          key: operation.key,
          kind: 'operation',
          name: operationEventName(registry.domain, operation.action, 'succeeded'),
          operation: operation.action,
          outcome: 'succeeded',
          properties: operation.publicProperties,
          title: operation.name,
        },
        {
          description: operation.description,
          eventSchemaVersion: registry.schemaVersion,
          failureStages: operation.failureStages,
          key: operation.key,
          kind: 'operation',
          name: operationEventName(registry.domain, operation.action, 'failed'),
          operation: operation.action,
          outcome: 'failed',
          properties: [
            ...operation.publicProperties,
            { name: 'failure_stage', type: 'enum', values: operation.failureStages },
          ],
          title: operation.name,
        },
      ]),
    ],
    operationDefinitions: registry.operations.map(operation => ({
      action: operation.action,
      failureStages: operation.failureStages,
      key: operation.key,
    })),
    routeDefinitions: registry.routes.map(route => ({
      eventName: routeEventName(registry.domain, route.feature),
      key: route.key,
      match: route.match,
    })),
  }
}

function validateEntry(entry, kind, keys) {
  assertObject(entry, kind)
  assertNonEmptyString(entry.key, `${kind} key`)
  assertUnique(keys, entry.key, 'duplicate key')
  validateLocalizedValue(entry.name, 'name')
  validateLocalizedValue(entry.description, 'description')
  assertArray(entry.publicProperties, 'publicProperties')
  for (const property of entry.publicProperties) {
    assertObject(property, 'public property')
    if (!SAFE_PROPERTY_NAMES.has(property.name)) {
      throw new Error(`unknown public property: ${property.name}`)
    }
    if (property.type !== 'enum') throw new Error(`public property ${property.name} must be enum`)
    assertArray(property.values, `public property ${property.name} values`)
    if (property.values.length === 0)
      throw new Error(`public property ${property.name} values empty`)
  }
}

function validateLocalizedValue(value, label) {
  assertObject(value, label)
  assertNonEmptyString(value['zh-CN'], `${label}.zh-CN`)
  assertNonEmptyString(value.en, `${label}.en`)
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
}

function assertSnakeCase(value, label) {
  assertNonEmptyString(value, label)
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) throw new Error(`${label} must be snake_case`)
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(label)
}

function assertUnique(values, value, label) {
  if (values.has(value)) throw new Error(`${label}: ${value}`)
  values.add(value)
}

async function renderTypeScript(catalog) {
  const eventMap = catalog.events
    .map(event => `  ${event.name}: ${renderPropertiesType(event.properties)}`)
    .join('\n')
  const propertyKeys = Object.fromEntries(
    catalog.events.map(event => [event.name, event.properties.map(property => property.name)])
  )
  const constraints = Object.fromEntries(
    catalog.events.map(event => [
      event.name,
      Object.fromEntries(event.properties.map(property => [property.name, property.values])),
    ])
  )

  return formatGenerated(
    `// Generated by scripts/generate-telemetry-catalog.mjs. Do not edit manually.\n\nexport interface SmartAppGeneratedEventMap {\n${eventMap}\n}\n\nexport type SmartAppGeneratedEventName = keyof SmartAppGeneratedEventMap\n\nexport const SMART_APP_EVENT_PROPERTY_KEYS = ${renderTypeScriptValue(propertyKeys)} as const\n\nexport const SMART_APP_EVENT_VALUE_CONSTRAINTS = ${renderTypeScriptValue(constraints)} as const\n\nexport const SMART_APP_ROUTE_DEFINITIONS = ${renderTypeScriptValue(catalog.routeDefinitions)} as const\n\nexport const SMART_APP_OPERATION_DEFINITIONS = ${renderTypeScriptValue(catalog.operationDefinitions)} as const\n\nexport type SmartAppRouteDefinition = (typeof SMART_APP_ROUTE_DEFINITIONS)[number]\nexport type SmartAppOperationDefinition = (typeof SMART_APP_OPERATION_DEFINITIONS)[number]\nexport type SmartAppOperationKey = SmartAppOperationDefinition['key']\n`,
    generatedTypesPath,
    'typescript'
  )
}

function renderPropertiesType(properties) {
  const values = properties.map(property => {
    const valueType = property.values.map(value => renderTypeScriptValue(value)).join(' | ')
    return `${property.name}: ${valueType}`
  })
  return `{ ${values.join('; ')} }`
}

function renderTypeScriptValue(value, indentation = 0) {
  if (typeof value === 'string') return `'${value.replaceAll("'", "\\'")}'`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const nestedIndentation = ' '.repeat(indentation + 2)
    const currentIndentation = ' '.repeat(indentation)
    return `[\n${value.map(item => `${nestedIndentation}${renderTypeScriptValue(item, indentation + 2)},`).join('\n')}\n${currentIndentation}]`
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  const nestedIndentation = ' '.repeat(indentation + 2)
  const currentIndentation = ' '.repeat(indentation)
  return `{\n${entries.map(([key, entry]) => `${nestedIndentation}${SAFE_IDENTIFIER_PATTERN.test(key) ? key : renderTypeScriptValue(key)}: ${renderTypeScriptValue(entry, indentation + 2)},`).join('\n')}\n${currentIndentation}}`
}

async function renderMarkdown(catalog) {
  const rows = catalog.events.map(event => {
    const properties = event.properties.map(property => `\`${property.name}\``).join(', ')
    return `| \`${event.name}\` | ${event.title['zh-CN']} | ${event.title.en} | ${event.description['zh-CN']} | ${event.description.en} | ${properties} |`
  })
  return formatGenerated(
    `# Wework Public Telemetry Event Catalog\n\nGenerated from \`src/telemetry/registry/smartAppRegistry.json\`.\n\n| Event | 名称 | Name | 中文说明 | Description | Public properties |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`,
    publicCatalogMarkdownPath,
    'markdown'
  )
}

async function renderJson(catalog) {
  return formatGenerated(JSON.stringify(catalog), publicCatalogJsonPath, 'json')
}

async function formatGenerated(content, filePath, parser) {
  const options = await resolveConfig(filePath)
  return format(content, { ...options, filepath: filePath, parser })
}

async function writeGeneratedFile(filePath, content, check) {
  const expected = content.endsWith('\n') ? content : `${content}\n`
  let current = null
  try {
    current = await readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (current === expected) return false
  if (check) return true
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, expected)
  return false
}

async function main() {
  const check = process.argv.includes('--check')
  const registry = JSON.parse(await readFile(registryPath, 'utf8'))
  const catalog = buildCatalog(registry)
  const [typeScript, json, markdown] = await Promise.all([
    renderTypeScript(catalog),
    renderJson(catalog),
    renderMarkdown(catalog),
  ])
  const drifted = await Promise.all([
    writeGeneratedFile(generatedTypesPath, typeScript, check),
    writeGeneratedFile(publicCatalogJsonPath, json, check),
    writeGeneratedFile(publicCatalogMarkdownPath, markdown, check),
  ])

  if (check && drifted.some(Boolean)) {
    console.error('Telemetry catalog is out of date. Run pnpm telemetry:catalog.')
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await access(registryPath)
  await main()
}
