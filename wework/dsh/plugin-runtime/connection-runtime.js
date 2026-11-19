import { ConnectionError, ConnectionRegistry, dependencySources } from './connections.js'
import { connectionTools } from './connection-tools.js'
import { collectObservation } from './connection-observations.js'
import { EventBus } from './event-bus.js'

function queryKey(value) {
  return JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map(key => [key, item[key]])
        )
      : item
  )
}

/** Provider execution depends on read capabilities, never on a model session. */
export function createConnectionRuntime({ dependencies, request, satisfies, beforeRequest }) {
  const registry = new ConnectionRegistry({
    inventory: () => dependencies.inventory(),
    satisfies,
    context: identity =>
      Object.freeze({
        ...identity,
        ...connectionTools(
          identity,
          dependencies,
          async (method, params) => {
            await beforeRequest?.()
            identity.signal.throwIfAborted()
            return request(method, params, { signal: identity.signal })
          },
          satisfies
        ),
      }),
  })
  const events = new EventBus()
  const registered = new WeakSet()
  return {
    registry,
    events,
    collect(providerId, input, signal) {
      const entry = registry.entries.get(providerId)
      if (!entry)
        throw new ConnectionError('connection_unavailable', 'Connection plugin is not active')
      if (!registered.has(entry)) {
        const unregister = events.registerProvider(providerId, {
          plan(entries) {
            const groups = new Map()
            for (const entry of entries) {
              const key = queryKey(entry.query)
              const group = groups.get(key) ?? { key, query: entry.query, entries: [] }
              group.entries.push(entry)
              groups.set(key, group)
            }
            return groups.values()
          },
          poll(input, signal) {
            return collectObservation(registry, providerId, input, { signal })
          },
          select: result => result,
        })
        entry.controller.signal.addEventListener('abort', unregister, { once: true })
        registered.add(entry)
      }
      const query = {
        source: input.source,
        checkpoint: input.checkpoint ?? null,
        force: input.force === true,
      }
      return events.request(providerId, query, signal)
    },
    dispose() {
      events.stop()
      registry.dispose()
    },
    registration: () => ({
      providerGuidance: [...registry.entries.values()]
        .filter(entry => entry.provider.assistance)
        .map(entry => ({ providerId: entry.id, assistance: entry.provider.assistance })),
      dependencyReferences: [...registry.entries.values()].flatMap(entry =>
        entry.provider.uses.flatMap(alias =>
          dependencySources(entry.definition.dependencies[alias]).map(source => ({
            providerId: entry.id,
            alias,
            ...source,
            version: entry.definition.dependencies[alias].version,
            readTools: entry.provider.mcpReadTools?.[alias] ?? [],
            cliReadTools: entry.provider.cliReadTools?.[alias] ?? null,
          }))
        )
      ),
    }),
  }
}
