import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/desktop/localExecutor'
import { notifyLocalPluginSkillsChanged } from '@/features/plugins/pluginTrial'

export interface StandaloneSkill {
  name: string
  description: string
  path: string
  scope: string
  enabled: boolean
  pluginId?: string | null
}
export interface SkillPreview {
  token: string
  skills: Array<{ name: string; description: string; path: string }>
}
export interface McpConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  bearer_token_env_var?: string
  enabled?: boolean
  [key: string]: unknown
}
export interface McpStatus {
  name: string
  runtimeStatus?:
    | 'notStarted'
    | 'starting'
    | 'connected'
    | 'authenticationRequired'
    | 'failed'
    | 'cancelled'
    | 'disabled'
    | null
  pluginId?: string | null
  serverInfo: { name?: string; version?: string } | null
  authStatus: 'unknown' | 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth'
  tools: Record<string, { name: string; description?: string }>
}
export interface McpEntry {
  name: string
  config: McpConfig | null
  status?: McpStatus
}
export interface McpListResult {
  entries: McpEntry[]
  statusError: boolean
}
let mcpServersCache: McpListResult | null = null
let mcpServersLoad: Promise<McpListResult> | null = null
const mcpProgressListeners = new Set<(result: McpListResult) => void>()

export function getCachedMcpServers(): McpListResult | null {
  return mcpServersCache
}

export function clearMcpServersCache(): void {
  mcpServersCache = null
}

async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  await ensureLocalExecutorStarted()
  return requestLocalExecutor<T>('codex.app_server_request', { method, params })
}
async function skillOperation<T>(params: Record<string, unknown>): Promise<T> {
  await ensureLocalExecutorStarted()
  return requestLocalExecutor<T>('executor.skills.manage', params)
}
export async function listStandaloneSkills(projectPath?: string) {
  const response = await rpc<{
    data: Array<{ skills: StandaloneSkill[]; errors: Array<{ message: string }> }>
  }>('skills/list', { cwds: projectPath ? [projectPath] : [], forceReload: true })
  const skills = new Map<string, StandaloneSkill>()
  for (const entry of response.data) for (const skill of entry.skills) skills.set(skill.path, skill)
  return {
    skills: [...skills.values()],
    errors: response.data.flatMap(entry => entry.errors ?? []),
  }
}
export async function setSkillEnabled(path: string, enabled: boolean) {
  await rpc('skills/config/write', { path, enabled })
  notifyLocalPluginSkillsChanged()
}
export const previewSkills = (source: string, sourceKind: 'git' | 'local', gitRef?: string) =>
  skillOperation<SkillPreview>({ action: 'preview', source, sourceKind, gitRef })
export const discardSkillPreview = (token: string) => skillOperation({ action: 'discard', token })
export async function installSkills(token: string, paths: string[], projectPath?: string) {
  await skillOperation<{ installed: string[] }>({
    action: 'install',
    token,
    paths,
    projectPath,
  })
  notifyLocalPluginSkillsChanged()
}
export async function removeSkill(path: string, projectPath?: string) {
  await skillOperation({ action: 'remove', path, projectPath })
  notifyLocalPluginSkillsChanged()
}
export async function readCapabilityHome(): Promise<string> {
  await ensureLocalExecutorStarted()
  const response = await requestLocalExecutor<{ weworkCodexHome: string }>(
    'executor.codex_home.status'
  )
  return response.weworkCodexHome
}

export function isPluginSkill(skill: StandaloneSkill): boolean {
  return Boolean(skill.pluginId) || skill.path.replaceAll('\\', '/').includes('/plugins/')
}
export function canRemoveSkill(
  skill: StandaloneSkill,
  home: string,
  projectPath?: string
): boolean {
  const path = skill.path.replaceAll('\\', '/')
  const parent = path.slice(0, path.lastIndexOf('/'))
  const root = parent.slice(0, parent.lastIndexOf('/'))
  return (
    !isPluginSkill(skill) &&
    !['system', 'admin'].includes(skill.scope) &&
    (root === `${home.replaceAll('\\', '/')}/skills` ||
      Boolean(projectPath && root === `${projectPath.replaceAll('\\', '/')}/.agents/skills`))
  )
}

function mergeMcpEntries(
  configuration: Record<string, McpConfig>,
  statuses: Map<string, McpStatus>
): McpEntry[] {
  const entries: McpEntry[] = Object.entries(configuration).map(([name, config]) => ({
    name,
    config,
    status: statuses.get(name),
  }))
  for (const [name, status] of statuses) {
    if (!(name in configuration)) entries.push({ name, config: null, status })
  }
  return entries
}

function cacheMcpResult(result: McpListResult): McpListResult {
  mcpServersCache = result
  for (const listener of mcpProgressListeners) listener(result)
  return result
}

async function loadMcpServers(): Promise<McpListResult> {
  const cachedEntries = mcpServersCache?.entries ?? []
  const cachedConfiguration = Object.fromEntries(
    cachedEntries.flatMap(entry => (entry.config ? [[entry.name, entry.config]] : []))
  )
  const cachedStatuses = new Map(
    cachedEntries.flatMap(entry => (entry.status ? [[entry.name, entry.status]] : []))
  )
  let configuration: Record<string, McpConfig> = {}
  const statuses = new Map<string, McpStatus>()
  let configurationLoaded = false
  const emitProgress = () => {
    const progressiveStatuses = new Map(cachedStatuses)
    for (const [name, status] of statuses) progressiveStatuses.set(name, status)
    cacheMcpResult({
      entries: mergeMcpEntries(
        configurationLoaded ? configuration : cachedConfiguration,
        progressiveStatuses
      ),
      statusError: false,
    })
  }
  const configurationPromise = rpc<{ config: { mcp_servers?: Record<string, McpConfig> } }>(
    'config/read',
    { includeLayers: false }
  ).then(response => {
    configuration = response.config.mcp_servers ?? {}
    configurationLoaded = true
    emitProgress()
  })
  const statusPromise = (async () => {
    let cursor: string | null = null
    const seen = new Set<string>()
    do {
      const response: { data: McpStatus[]; nextCursor: string | null } = await rpc(
        'mcpServerStatus/list',
        { cursor, limit: 100 }
      )
      for (const status of response.data) statuses.set(status.name, status)
      emitProgress()
      cursor = response.nextCursor
      if (cursor && seen.has(cursor)) throw new Error('Repeated MCP cursor')
      if (cursor) seen.add(cursor)
    } while (cursor)
  })()
  const [configurationResult, statusResult] = await Promise.allSettled([
    configurationPromise,
    statusPromise,
  ])
  if (configurationResult.status === 'rejected') throw configurationResult.reason
  return cacheMcpResult({
    entries: mergeMcpEntries(configuration, statuses),
    statusError: statusResult.status === 'rejected',
  })
}

export async function listMcpServers(
  onProgress?: (result: McpListResult) => void
): Promise<McpListResult> {
  if (onProgress) {
    mcpProgressListeners.add(onProgress)
    if (mcpServersCache) onProgress(mcpServersCache)
  }
  try {
    mcpServersLoad ??= loadMcpServers().finally(() => {
      mcpServersLoad = null
    })
    return await mcpServersLoad
  } finally {
    if (onProgress) mcpProgressListeners.delete(onProgress)
  }
}
export async function reloadMcpServers() {
  await rpc('config/mcpServer/reload')
}
export async function saveMcpServer(name: string, config: McpConfig | null) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid MCP server name')
  if (config?.bearer_token_env_var) {
    let secureUrl = false
    try {
      secureUrl = Boolean(config.url && new URL(config.url).protocol === 'https:')
    } catch {
      // The caller displays this validation error without persisting the configuration.
    }
    if (!secureUrl) throw new Error('Bearer token authentication requires an HTTPS MCP URL')
  }
  await rpc('config/value/write', {
    keyPath: `mcp_servers.${name}`,
    // Codex returns optional defaults as null, which TOML cannot serialize.
    value:
      config && Object.fromEntries(Object.entries(config).filter(([, value]) => value != null)),
    mergeStrategy: 'replace',
  })
}
export async function loginMcpServer(name: string): Promise<string> {
  const response = await rpc<{ authorizationUrl: string }>('mcpServer/oauth/login', { name })
  return response.authorizationUrl
}
