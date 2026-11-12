import assert from 'node:assert/strict'
import { wireDeclarations } from './model-wire-contract.mjs'

export function programmaticExecTools(request) {
  const declarations = new Map()
  // Current declarations are authoritative; only Lite reconstructs its incremental history.
  const catalog = request.tools === undefined ? { input: request.input } : { tools: request.tools }
  for (const tool of wireDeclarations(catalog, 'responses'))
    declarations.set(JSON.stringify([tool.namespace ?? null, tool.name]), tool)
  return [...declarations.values()].filter(
    tool =>
      ['exec', 'functions__exec'].includes(tool.name) &&
      (tool.type === 'custom' ||
        (tool.type === 'function' && tool.parameters?.properties?.input?.type === 'string'))
  )
}

export function programmaticSelection(request, name, args) {
  const entries = programmaticExecTools(request)
  assert.equal(entries.length, 1, 'Expected exactly one native Code Mode exec declaration')
  return { name, arguments: args, codeMode: { ...entries[0], targetName: name } }
}

export function programmaticInput(name, args) {
  const shell = ['exec_command', 'write_stdin'].includes(name)
  return [
    `const requested = ${JSON.stringify(name)}`,
    'const matches = ALL_TOOLS.filter(tool => tool.name === requested || tool.name.endsWith("__" + requested))',
    `if (matches.length !== 1) throw new Error('Native capability is missing or ambiguous: ' + ${JSON.stringify(name)})`,
    `const result = await tools[matches[0].name](${JSON.stringify(args)})`,
    ...(shell
      ? [
          'text(result.session_id ? `Process running with session ID ${result.session_id}` : `Process exited with code ${result.exit_code}`)',
          'text(result.output)',
        ]
      : [
          'if (result?.structuredContent !== undefined) text(result.structuredContent); else if (Array.isArray(result?.content)) { for (const part of result.content) { if (part.type === "text") text(part.text); else if (part.type === "image") image(part) } } else text(result)',
        ]),
  ].join('\n')
}

export function discoverySelection(request, query, qualifiedName) {
  const entries = programmaticExecTools(request)
  assert.equal(
    entries.length,
    1,
    `Expected exactly one native Code Mode discovery declaration: ${JSON.stringify({
      current: wireDeclarations({ tools: request.tools }, 'responses').map(tool => ({
        name: tool.name,
        namespace: tool.namespace,
        type: tool.type,
      })),
      historical: wireDeclarations({ input: request.input }, 'responses').map(tool => ({
        name: tool.name,
        namespace: tool.namespace,
        type: tool.type,
      })),
    })}`
  )
  const input = [
    `const query = ${JSON.stringify(query.toLowerCase())}`,
    `const qualifiedName = ${JSON.stringify(qualifiedName?.replace(/^mcp__/, '') ?? null)}`,
    'const words = query.split(/[^a-z0-9_]+/).filter(Boolean)',
    'const matches = ALL_TOOLS.filter(tool => { if (qualifiedName) return tool.name.replace(/^mcp__/, "") === qualifiedName; const text = (tool.name + " " + tool.description).toLowerCase(); return words.every(word => text.includes(word)) || words.some(word => word.includes("_") && tool.name.endsWith("__" + word)) })',
    'if (qualifiedName ? matches.length !== 1 : !matches.length || matches.length > 8) throw new Error("Native discovery requires " + (qualifiedName ? "one exact capability" : "between one and eight capabilities") + ": " + JSON.stringify({ query, qualifiedName, matchedNames: matches.map(tool => tool.name), availableNames: ALL_TOOLS.map(tool => tool.name) }))',
    'text({ tools: matches })',
  ].join('\n')
  return { name: entries[0].name, codeMode: { ...entries[0], input } }
}

// Only the model-side oracle groups real ALL_TOOLS metadata; no schemas are invented.
export function normalizeDiscoveredTools(tools) {
  const namespaces = new Map()
  const output = []
  for (const tool of tools) {
    if (!tool.name?.includes('__') || !tool.description?.includes('exec tool declaration:')) {
      output.push(tool)
      continue
    }
    const separator = tool.name.lastIndexOf('__')
    const name = tool.name.slice(0, separator).replace(/^mcp__/, '')
    const namespace = namespaces.get(name) ?? { type: 'namespace', name, tools: [] }
    if (!namespaces.has(name)) {
      namespaces.set(name, namespace)
      output.push(namespace)
    }
    namespace.tools.push({
      type: 'function',
      name: tool.name.slice(separator + 2),
      description: tool.description,
      codeModeName: tool.name,
    })
  }
  return output
}
