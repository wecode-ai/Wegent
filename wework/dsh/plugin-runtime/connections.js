import { readFile } from 'node:fs/promises'
import { validRange } from 'semver'

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const METHODS = ['check', 'listResources', 'validate', 'initialize', 'collect']
const OPTIONAL_METHODS = ['readSource', 'executeAction']

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
    requireValue(
      dependency.alternateSources === undefined || Array.isArray(dependency.alternateSources),
      'Invalid alternate dependency sources'
    )
    const sources = dependencySources(dependency)
    const identities = new Set()
    for (const source of sources) {
      requireValue(record(source), 'Missing dependency source')
      for (const key of ['marketplaceId', 'pluginId']) {
        requireValue(typeof source[key] === 'string' && source[key].trim(), `Missing ${key}`)
      }
      const identity = JSON.stringify([source.marketplaceId, source.pluginId])
      requireValue(!identities.has(identity), 'Duplicate dependency source')
      identities.add(identity)
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
    if (provider.resourceQuerySchema !== undefined) {
      const schema = provider.resourceQuerySchema
      requireValue(
        record(schema) &&
          schema.type === 'object' &&
          record(schema.properties) &&
          Object.entries(schema.properties).every(
            ([key, value]) => ID.test(key) && record(value)
          ) &&
          (schema.required === undefined ||
            (Array.isArray(schema.required) &&
              schema.required.every(
                key => typeof key === 'string' && Object.hasOwn(schema.properties, key)
              ) &&
              new Set(schema.required).size === schema.required.length)),
        'Invalid resource query schema'
      )
    }
    requireValue(
      provider.allResourceKinds === undefined ||
        (Array.isArray(provider.allResourceKinds) &&
          provider.allResourceKinds.every(kind => provider.resourceKinds.includes(kind))),
      'Invalid all-resource kinds'
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
    if (provider.actions !== undefined) {
      requireValue(Array.isArray(provider.actions), 'Invalid connection actions')
      const actions = new Set()
      for (const action of provider.actions) {
        requireValue(
          record(action) &&
            typeof action.id === 'string' &&
            ID.test(action.id) &&
            !actions.has(action.id) &&
            Array.isArray(action.resourceKinds) &&
            action.resourceKinds.length > 0 &&
            action.resourceKinds.every(kind => provider.resourceKinds.includes(kind)),
          'Invalid or duplicate connection action'
        )
        actions.add(action.id)
      }
    }
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
            ((typeof declaration.connectorSlug === 'string' &&
              ID.test(declaration.connectorSlug) &&
              declaration.toolId === undefined) ||
              (typeof declaration.toolId === 'string' &&
                ID.test(declaration.toolId) &&
                declaration.connectorSlug === undefined)),
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

export function dependencySources(dependency) {
  return [dependency.source, ...(dependency.alternateSources ?? [])]
}

// The caller supplies its existing version implementation; no second resolver is maintained.
export function dependencyPlan(definition, inventory, satisfies) {
  return Object.entries(definition.dependencies).map(([alias, dependency]) => {
    const candidates = dependencySources(dependency).flatMap(source => {
      const matches = inventory.filter(
        item => item.marketplaceId === source.marketplaceId && item.pluginId === source.pluginId
      )
      requireValue(matches.length <= 1, `Ambiguous dependency: ${alias}`)
      return matches
    })
    // Reuse an installed declared source before considering a fresh installation.
    const installed = candidates.find(item => item.installed) ?? candidates[0]
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
      requireValue(
        !provider.actions?.length || typeof implementation.executeAction === 'function',
        `Missing connection action implementation: ${id}`
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
          authTarget: availability.authTarget ?? entry.provider.authTarget,
          availability: {
            status: availability.status,
            ...(availability.code ? { code: availability.code } : {}),
          },
        }
      })
    )
  }

  async call(id, method, input) {
    const entry = this.entries.get(id)
    if (!entry)
      throw new ConnectionError('connection_unavailable', 'Connection plugin is not active')
    requireValue(
      METHODS.includes(method) || OPTIONAL_METHODS.includes(method),
      'Unknown connection method'
    )
    if (typeof entry.implementation[method] !== 'function')
      throw new ConnectionError(
        method === 'executeAction' ? 'connection_action_unsupported' : 'source_read_unsupported',
        method === 'executeAction'
          ? 'This provider does not support connection actions'
          : 'This provider does not support source reads'
      )
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
    if (method === 'listResources' && params.scope === 'all') {
      requireValue(
        entry.provider.allResourceKinds?.includes(params.kind),
        'Unsupported all-resource scope'
      )
    }
    const source = ['collect', 'readSource', 'executeAction'].includes(method)
      ? params.source
      : method === 'validate'
        ? params
        : null
    if (source?.scope === 'all') {
      requireValue(
        source.id === '*' && entry.provider.allResourceKinds?.includes(source.kind),
        'Unsupported all-resource scope'
      )
    } else if (source) {
      requireValue(source.scope === undefined && source.id !== '*', 'Invalid resource scope')
    }
    if (['collect', 'readSource', 'executeAction'].includes(method)) {
      requireValue(params.source?.providerId === id, 'Source belongs to another provider')
      if (method === 'executeAction') {
        requireValue(
          source.scope === undefined &&
            source.id !== '*' &&
            entry.provider.actions?.some(
              action =>
                action.id === params.action && action.resourceKinds.includes(params.source.kind)
            ),
          'Connection action is not declared for this resource'
        )
      }
      await entry.implementation.validate(context, params.source)
      if (method === 'collect' && (params.checkpoint === null || params.checkpoint === undefined)) {
        params.checkpoint = await entry.implementation.initialize(context, params.source)
      }
    }
    entry.controller.signal.throwIfAborted()
    const result = await entry.implementation[method](context, params)
    entry.controller.signal.throwIfAborted()
    validateProviderResult(entry.provider, method, result)
    if (method === 'collect' && source.scope === 'all') {
      requireValue(
        result.events.every(
          event =>
            record(event.resource) &&
            event.resource.kind === source.kind &&
            ['id', 'name'].every(
              key =>
                typeof event.resource[key] === 'string' &&
                event.resource[key].trim() &&
                event.resource[key].length <= 512
            ) &&
            event.resource.id !== '*'
        ),
        'Missing concrete event resource'
      )
    }
    if (method === 'listResources') {
      requireValue(
        result.items.every(item =>
          params.scope === 'all'
            ? item.scope === 'all' && item.id === '*'
            : item.scope === undefined && item.id !== '*'
        ),
        'Invalid resource selection scope'
      )
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
  if (method === 'readSource') {
    requireValue(
      record(result) &&
        Array.isArray(result.items) &&
        result.items.length <= 20 &&
        result.items.every(
          item =>
            record(item) &&
            typeof item.id === 'string' &&
            item.id.length > 0 &&
            typeof item.at === 'string' &&
            Number.isFinite(Date.parse(item.at)) &&
            typeof item.text === 'string' &&
            item.text.length <= 20000
        ) &&
        typeof result.hasMore === 'boolean',
      'Invalid source read result'
    )
  }
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
    if (result.availability !== undefined) {
      const availability = result.availability
      requireValue(
        record(availability) && ['ready', 'auth_required', 'error'].includes(availability.status),
        'Invalid resource availability'
      )
      if (availability.authTarget !== undefined) {
        const target = availability.authTarget
        requireValue(
          record(target) &&
            ['pluginKey', 'connectorSlug'].every(
              key =>
                typeof target[key] === 'string' && target[key].trim() && target[key].length <= 256
            ) &&
            (target.instance === undefined ||
              (typeof target.instance === 'string' && target.instance.trim())),
          'Invalid resource authorization target'
        )
      }
    }
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
