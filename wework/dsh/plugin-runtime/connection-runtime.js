import { ConnectionRegistry, dependencySources } from './connections.js'
import { connectionTools } from './connection-tools.js'

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
  return {
    registry,
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
