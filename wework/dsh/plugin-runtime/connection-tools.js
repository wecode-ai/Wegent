import { ConnectionError, dependencyPlan } from './connections.js'

// Dependency identity comes from the registered provider, never from call arguments.
export function connectionTools(identity, dependencies, request, satisfies) {
  const declaredDependencies = structuredClone(identity.dependencies)
  const invoke = async (transport, alias, operation, input = {}) => {
    identity.signal.throwIfAborted()
    const declared = declaredDependencies.find(item => item.alias === alias)
    if (!declared)
      throw new ConnectionError('connection_dependency_denied', 'Undeclared connection dependency')
    const plan = dependencyPlan(
      { dependencies: { [alias]: declared } },
      await dependencies.inventory(),
      satisfies
    )
    const dependency = plan[0]
    if (dependency.status !== 'ready')
      throw new ConnectionError(
        `dependency_${dependency.status}`,
        'Connection dependency is not ready'
      )
    identity.signal.throwIfAborted()
    const result = await request(`runtime.connections.${transport}`, {
      providerId: identity.providerId,
      dependencyAlias: alias,
      source: dependency.source,
      expectedVersion: dependency.resolved.version,
      operation,
      ...input,
    })
    identity.signal.throwIfAborted()
    return result
  }
  const mcp = Object.freeze({
    listTools: alias => invoke('mcp', alias, 'listTools'),
    callTool: (alias, input) =>
      invoke('mcp', alias, 'callTool', {
        server: input.server,
        tool: input.tool,
        arguments: input.arguments ?? {},
      }),
  })
  const cli = Object.freeze({
    callTool: (alias, input) =>
      invoke('cli', alias, 'callTool', {
        tool: input.tool,
        arguments: input.arguments ?? {},
      }),
  })
  return Object.freeze({ mcp, cli })
}
