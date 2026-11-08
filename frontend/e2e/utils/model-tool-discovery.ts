export interface ModelToolDefinition {
  name: string
  namespace?: string
}

export function codeModeToolCall(
  request: unknown,
  requestedName: string,
  args: Record<string, unknown>,
  inspectToolNames: string[] = []
): { toolName: string; arguments: { input: string } } | null {
  const exec = modelToolDefinitions(request).find(tool =>
    ['exec', 'functions__exec'].includes(tool.name)
  )
  if (!exec || requestedName === exec.name) return null
  const input = [
    `const requested = ${JSON.stringify(requestedName)}`,
    'const matches = ALL_TOOLS.filter(tool => tool.name === requested || tool.name.endsWith("__" + requested))',
    'if (matches.length !== 1) throw new Error("Native capability missing or ambiguous: " + requested)',
    `const inspected = ${JSON.stringify(inspectToolNames)}`,
    'text({ tools: ALL_TOOLS.filter(tool => matches.includes(tool) || inspected.some(name => tool.name === name || tool.name.endsWith("__" + name))) })',
    `text(await tools[matches[0].name](${JSON.stringify(args)}))`,
  ].join('\n')
  return { toolName: exec.name, arguments: { input } }
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
        if (/^Script completed\nWall time [^\n]+\nOutput:\n/.test(value)) {
          const output = value.slice(value.indexOf('\nOutput:\n') + '\nOutput:\n'.length)
          for (const line of output.split('\n').filter(Boolean)) {
            try {
              visit(JSON.parse(line))
            } catch {
              /* Non-JSON result text is not a catalog. */
            }
          }
        }
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
  if (!missing || !search) return null
  const query = missing.split('__').pop()!
  const alreadySearched = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(alreadySearched)
    if (!value || typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    const call = (record.function ?? record) as Record<string, unknown>
    if (call.name === search.name && typeof call.arguments === 'string') {
      const args = JSON.parse(call.arguments) as { query?: string }
      if (args.query === query) return true
    }
    return Object.values(record).some(alreadySearched)
  }
  if (alreadySearched(request)) {
    throw new Error(`Deferred tool search did not make ${missing} available`)
  }
  return { toolName: search.name, arguments: { query, limit: 1 } }
}

export function resolveToolName(request: unknown, requestedName: string): string {
  return (
    modelToolDefinitions(request).find(tool => modelToolMatches(tool, requestedName))?.name ??
    requestedName
  )
}
