import type { InstalledMCPServerConfig } from '@/types/api'
import type { CustomMcpFormState } from './McpManagementSections'

const supportedTypes = new Set(['streamable-http', 'sse', 'stdio', 'http'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function asStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, item]) => [key, item])
  )
}

function normalizeType(value: unknown): InstalledMCPServerConfig['type'] {
  const raw = asString(value)
  if (supportedTypes.has(raw)) {
    return raw as InstalledMCPServerConfig['type']
  }
  return 'streamable-http'
}

function pickImportedServer(value: unknown): { name: string; server: Record<string, unknown> } {
  if (!isRecord(value)) {
    throw new Error('JSON must be an object')
  }

  const mcpServers = isRecord(value.mcpServers) ? value.mcpServers : value.mcp_servers
  if (isRecord(mcpServers)) {
    const [name, server] = Object.entries(mcpServers).find(([, item]) => isRecord(item)) ?? []
    if (!name || !isRecord(server)) {
      throw new Error('mcpServers is empty')
    }
    return { name, server }
  }

  if (isRecord(value.server)) {
    return {
      name: asString(value.name) || asString(value.displayName),
      server: value.server,
    }
  }

  const entries = Object.entries(value)
  if (
    entries.length === 1 &&
    isRecord(entries[0][1]) &&
    ('command' in entries[0][1] || 'url' in entries[0][1] || 'base_url' in entries[0][1])
  ) {
    return { name: entries[0][0], server: entries[0][1] }
  }

  return {
    name: asString(value.name) || asString(value.displayName),
    server: value,
  }
}

export function parseCustomMcpJson(input: string): CustomMcpFormState {
  const parsed = JSON.parse(input) as unknown
  const { name, server } = pickImportedServer(parsed)
  const serverType =
    asString(server.command) || server.type === 'stdio' ? 'stdio' : normalizeType(server.type)
  const url =
    asString(server.url) ||
    asString(server.base_url) ||
    asString(server.baseUrl) ||
    asString(server.endpoint)
  const env = asStringRecord(server.env)
  const headers = asStringRecord(server.headers)
  const displayName =
    asString(server.displayName) || asString(server.display_name) || asString(server.name) || name

  return {
    name,
    displayName,
    description: asString(server.description),
    type: serverType,
    url,
    command: asString(server.command),
    args: asStringArray(server.args).join(' '),
    envJson: env ? JSON.stringify(env, null, 2) : '',
    headersJson: headers ? JSON.stringify(headers, null, 2) : '',
  }
}

export function parseOptionalStringRecordJson(value: string): Record<string, string> | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const parsed = JSON.parse(trimmed) as unknown
  if (!isRecord(parsed)) {
    throw new Error('Expected a JSON object')
  }

  return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]))
}
