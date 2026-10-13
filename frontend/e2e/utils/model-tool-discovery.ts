export interface ModelToolDefinition {
  name: string
  namespace?: string
}

export function modelToolMatches(tool: ModelToolDefinition, requested: string): boolean {
  return (
    tool.name.endsWith(requested) ||
    Boolean(tool.namespace && requested.endsWith(`${tool.namespace}__${tool.name}`))
  )
}

export function modelToolDefinitions(request: unknown): ModelToolDefinition[] {
  const definitions: ModelToolDefinition[] = []
  const add = (value: unknown, namespace?: string) => {
    if (!value || typeof value !== 'object') return
    const tool = value as Record<string, unknown>
    const fn = tool.function as { name?: string } | undefined
    const name = fn?.name ?? (typeof tool.name === 'string' ? tool.name : undefined)
    if (Array.isArray(tool.tools)) {
      tool.tools.forEach(child => add(child, name))
    } else if (name) {
      definitions.push({
        name,
        namespace: namespace ?? (typeof tool.namespace === 'string' ? tool.namespace : undefined),
      })
    }
  }
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      try {
        visit(JSON.parse(value))
      } catch {
        // Ordinary message text does not define tools.
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit)
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (Array.isArray(record.tools)) record.tools.forEach(tool => add(tool))
      Object.entries(record)
        .filter(([key]) => key !== 'tools')
        .forEach(([, child]) => visit(child))
    }
  }
  visit(request)
  return definitions
}

export function deferredToolSearchCall(
  request: unknown,
  requestedNames: string[]
): { toolName: string; arguments: { query: string; limit: number } } | null {
  const tools = modelToolDefinitions(request)
  const missing = requestedNames.find(name => !tools.some(tool => modelToolMatches(tool, name)))
  const search = tools.find(tool => tool.name.endsWith('search_deferred_tools'))
  return missing && search
    ? { toolName: search.name, arguments: { query: missing, limit: 1 } }
    : null
}
