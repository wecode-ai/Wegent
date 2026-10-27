import { readFile } from 'node:fs/promises'
import { validRange } from 'semver'

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const METHODS = ['check', 'listResources', 'validate', 'initialize', 'collect']

export class ConnectionError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function parseConnections(manifest) {
  requireValue(record(manifest), 'Plugin manifest must be an object')
  const value = manifest.wework?.connections
  if (value === undefined) return null
  requireValue(value?.apiVersion === 1, 'Unsupported connection protocol version')
  requireValue(
    typeof manifest.name === 'string' && manifest.name.length > 0,
    'Missing package name'
  )
  const dependencies = value.dependencies ?? {}
  requireValue(record(dependencies), 'Connection dependencies must be an object')
  for (const [alias, dependency] of Object.entries(dependencies)) {
    requireValue(ID.test(alias), 'Invalid dependency alias')
    requireValue(dependency?.kind === 'codexPlugin', 'Unsupported connection dependency')
    requireValue(record(dependency.source), 'Missing dependency source')
    for (const key of ['marketplaceId', 'pluginId']) {
      requireValue(
        typeof dependency.source[key] === 'string' && dependency.source[key].trim(),
        `Missing ${key}`
      )
    }
    requireValue(
      typeof dependency.version === 'string' && validRange(dependency.version),
      'Invalid dependency version'
    )
  }
  requireValue(
    Array.isArray(value.providers) && value.providers.length > 0,
    'Missing connection providers'
  )
  const ids = new Set()
  for (const provider of value.providers) {
    requireValue(record(provider), 'Invalid provider declaration')
    requireValue(
      typeof provider.id === 'string' && ID.test(provider.id) && !ids.has(provider.id),
      'Invalid or duplicate provider id'
    )
    ids.add(provider.id)
    requireValue(
      typeof provider.displayName === 'string' && provider.displayName.trim(),
      'Missing provider name'
    )
    requireValue(
      Array.isArray(provider.uses) &&
        provider.uses.every(alias => Object.hasOwn(dependencies, alias)),
      'Unknown provider dependency'
    )
    requireValue(
      Array.isArray(provider.resourceKinds) &&
        provider.resourceKinds.length > 0 &&
        provider.resourceKinds.every(kind => typeof kind === 'string' && ID.test(kind)),
      'Invalid resource kinds'
    )
    requireValue(
      record(provider.resourceLabels) &&
        provider.resourceKinds.every(
          kind =>
            typeof provider.resourceLabels[kind] === 'string' &&
            provider.resourceLabels[kind].trim()
        ),
      'Missing resource labels'
    )
    requireValue(
      Array.isArray(provider.eventTypes) &&
        provider.eventTypes.length > 0 &&
        provider.eventTypes.every(kind => typeof kind === 'string' && ID.test(kind)),
      'Invalid event types'
    )
    requireValue(
      JSON.stringify(provider.collectionModes) === '["poll"]',
      'Only poll collection is supported'
    )
    if (provider.mcpReadTools !== undefined) {
      requireValue(record(provider.mcpReadTools), 'Invalid MCP read tool declarations')
      for (const [alias, tools] of Object.entries(provider.mcpReadTools)) {
        requireValue(provider.uses.includes(alias), 'MCP tools must use a declared dependency')
        requireValue(
          Array.isArray(tools) &&
            tools.every(
              tool =>
                record(tool) &&
                ['server', 'tool'].every(
                  key =>
                    typeof tool[key] === 'string' && tool[key].length > 0 && tool[key].length <= 512
                )
            ),
          'Invalid MCP read tool identity'
        )
      }
    }
    if (provider.cliReadTools !== undefined) {
      requireValue(record(provider.cliReadTools), 'Invalid CLI read declarations')
      for (const [alias, declaration] of Object.entries(provider.cliReadTools)) {
        requireValue(provider.uses.includes(alias), 'CLI tools must use a declared dependency')
        requireValue(
          record(declaration) &&
            typeof declaration.connectorSlug === 'string' &&
            ID.test(declaration.connectorSlug),
          'Missing CLI connector'
        )
        requireValue(
          Array.isArray(declaration.outputArgs) &&
            declaration.outputArgs.length <= 16 &&
            declaration.outputArgs.every(
              arg =>
                typeof arg === 'string' &&
                arg.length > 0 &&
                arg.length <= 256 &&
                !arg.includes('\0')
            ),
          'Invalid CLI output arguments'
        )
        requireValue(
          record(declaration.operations) && Object.keys(declaration.operations).length > 0,
          'Missing CLI read operations'
        )
        for (const [operation, spec] of Object.entries(declaration.operations)) {
          requireValue(
            ID.test(operation) &&
              record(spec) &&
              Array.isArray(spec.command) &&
              spec.command.length > 0 &&
              spec.command.length <= 8 &&
              spec.command.every(part => typeof part === 'string' && ID.test(part)),
            'Invalid CLI read command'
          )
          requireValue(
            record(spec.parameters) &&
              Object.entries(spec.parameters).every(
                ([key, flag]) =>
                  ID.test(key) && typeof flag === 'string' && /^--[a-z][a-z0-9-]*$/.test(flag)
              ) &&
              new Set(Object.values(spec.parameters)).size === Object.keys(spec.parameters).length,
            'Invalid CLI parameters'
          )
        }
      }
    }
  }
  return structuredClone({
    apiVersion: 1,
    packageName: manifest.name,
    dependencies,
    providers: value.providers,
  })
}

// The caller supplies its existing version implementation; no second resolver is maintained.
export function dependencyPlan(definition, inventory, satisfies) {
  return Object.entries(definition.dependencies).map(([alias, dependency]) => {
    const matches = inventory.filter(
      item =>
        item.marketplaceId === dependency.source.marketplaceId &&
        item.pluginId === dependency.source.pluginId
    )
    requireValue(matches.length <= 1, `Ambiguous dependency: ${alias}`)
    const installed = matches[0]
    const status = !installed?.installed
      ? 'missing'
      : !installed.enabled
        ? 'disabled'
        : dependency.version !== '*' &&
            (!installed.version || !satisfies(installed.version, dependency.version))
          ? 'incompatible'
          : 'ready'
    return { alias, ...dependency, status, resolved: installed ?? null }
  })
}

export class ConnectionRegistry {
  constructor({ inventory, satisfies, context }) {
    this.inventory = inventory
    this.satisfies = satisfies
    this.context = context
    this.entries = new Map()
  }

  async register(owner, manifestUrl, implementations) {
    requireValue(owner && typeof owner.effect === 'function', 'Missing connection owner')
    const definition = parseConnections(JSON.parse(await readFile(manifestUrl, 'utf8')))
    requireValue(definition, 'Package has no connection declaration')
    const entries = definition.providers.map(provider => {
      const id = `${definition.packageName}/${provider.id}`
      requireValue(!this.entries.has(id), `Connection already registered: ${id}`)
      const implementation = implementations[provider.id]
      requireValue(
        METHODS.every(method => typeof implementation?.[method] === 'function'),
        `Incomplete connection implementation: ${id}`
      )
      return { id, definition, provider, implementation, controller: new AbortController() }
    })
    for (const entry of entries) this.entries.set(entry.id, entry)
    const dispose = () => {
      for (const entry of entries) {
        entry.controller.abort()
        if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id)
      }
    }
    try {
      owner.effect(() => dispose, `wework connections: ${definition.packageName}`)
    } catch (error) {
      dispose()
      throw error
    }
    return dispose
  }

  async catalog() {
    let inventory = []
    let inventoryError = false
    if ([...this.entries.values()].some(entry => entry.provider.uses.length)) {
      try {
        inventory = await this.inventory()
      } catch {
        inventoryError = true
      }
    }
    return Promise.all(
      [...this.entries.values()].map(async entry => {
        if (inventoryError && entry.provider.uses.length) {
          return {
            ...entry.provider,
            id: entry.id,
            packageName: entry.definition.packageName,
            dependencies: Object.entries(entry.definition.dependencies)
              .filter(([alias]) => entry.provider.uses.includes(alias))
              .map(([alias, dependency]) => ({
                alias,
                ...dependency,
                status: 'unavailable',
                resolved: null,
              })),
            availability: { status: 'dependency_unavailable' },
          }
        }
        const dependencies = dependencyPlan(entry.definition, inventory, this.satisfies).filter(
          item => entry.provider.uses.includes(item.alias)
        )
        const blocked = dependencies.find(item => item.status !== 'ready')
        let availability = { status: `dependency_${blocked?.status}` }
        if (!blocked) {
          try {
            availability = await entry.implementation.check(this.contextFor(entry, dependencies))
          } catch (error) {
            availability = { status: 'error', code: error.code ?? 'connection_failed' }
          }
        }
        return {
          ...entry.provider,
          id: entry.id,
          packageName: entry.definition.packageName,
          dependencies,
          availability,
        }
      })
    )
  }

  async call(id, method, input) {
    const entry = this.entries.get(id)
    if (!entry)
      throw new ConnectionError('connection_unavailable', 'Connection plugin is not active')
    requireValue(METHODS.includes(method), 'Unknown connection method')
    const dependencies = dependencyPlan(
      entry.definition,
      entry.provider.uses.length ? await this.inventory() : [],
      this.satisfies
    ).filter(item => entry.provider.uses.includes(item.alias))
    const blocked = dependencies.find(item => item.status !== 'ready')
    if (blocked)
      throw new ConnectionError(
        `dependency_${blocked.status}`,
        `Dependency ${blocked.alias} is ${blocked.status}`
      )
    if (this.entries.get(id) !== entry)
      throw new ConnectionError('connection_unavailable', 'Connection plugin was stopped')
    const context = this.contextFor(entry, dependencies)
    const params = structuredClone(input)
    if (method === 'collect') {
      requireValue(params.source?.providerId === id, 'Source belongs to another provider')
      await entry.implementation.validate(context, params.source)
      if (params.checkpoint === null || params.checkpoint === undefined) {
        params.checkpoint = await entry.implementation.initialize(context, params.source)
      }
    }
    entry.controller.signal.throwIfAborted()
    const result = await entry.implementation[method](context, params)
    entry.controller.signal.throwIfAborted()
    validateProviderResult(entry.provider, method, result)
    if (method === 'listResources') {
      return { ...result, items: result.items.map(item => ({ ...item, providerId: id })) }
    }
    return result
  }

  contextFor(entry, dependencies) {
    return Object.freeze({
      ...this.context({
        packageName: entry.definition.packageName,
        providerId: entry.id,
        dependencies: structuredClone(dependencies),
        signal: entry.controller.signal,
      }),
      signal: entry.controller.signal,
    })
  }

  dispose() {
    for (const entry of this.entries.values()) entry.controller.abort()
    this.entries.clear()
  }
}

function validateProviderResult(provider, method, result) {
  if (method === 'collect') {
    requireValue(
      record(result) &&
        record(result.nextCheckpoint) &&
        typeof result.hasMore === 'boolean' &&
        Array.isArray(result.events),
      'Invalid collection result'
    )
    requireValue(
      result.events.length <= 1000 &&
        result.events.every(
          event =>
            record(event) &&
            ['id', 'text', 'at'].every(
              key => typeof event[key] === 'string' && event[key].length > 0
            ) &&
            provider.eventTypes.includes(event.eventType)
        ),
      'Invalid connection event'
    )
  }
  if (method === 'listResources') {
    requireValue(
      record(result) && Array.isArray(result.items) && result.items.length <= 1000,
      'Invalid resource page'
    )
    requireValue(
      result.items.every(
        item =>
          record(item) &&
          ['id', 'profile', 'name'].every(
            key => typeof item[key] === 'string' && item[key].trim()
          ) &&
          provider.resourceKinds.includes(item.kind)
      ),
      'Invalid connection resource'
    )
    requireValue(
      result.hasMore !== true ||
        (typeof result.nextCursor === 'string' && result.nextCursor.length > 0),
      'Missing resource pagination cursor'
    )
  }
}

function requireValue(condition, message) {
  if (!condition) throw new ConnectionError('invalid_connection', message)
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
