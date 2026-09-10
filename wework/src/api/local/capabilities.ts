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

export async function listMcpServers(): Promise<{ entries: McpEntry[]; statusError: boolean }> {
  const configuration = await rpc<{ config: { mcp_servers?: Record<string, McpConfig> } }>(
    'config/read',
    { includeLayers: false }
  )
  const entries = new Map<string, McpEntry>(
    Object.entries(configuration.config.mcp_servers ?? {}).map(([name, config]) => [
      name,
      { name, config },
    ])
  )
  let cursor: string | null = null
  const seen = new Set<string>()
  try {
    do {
      const response: { data: McpStatus[]; nextCursor: string | null } = await rpc(
        'mcpServerStatus/list',
        { cursor, limit: 100 }
      )
      for (const status of response.data) {
        entries.set(status.name, {
          name: status.name,
          config: entries.get(status.name)?.config ?? null,
          status,
        })
      }
      cursor = response.nextCursor
      if (cursor && seen.has(cursor)) throw new Error('Repeated MCP cursor')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return { entries: [...entries.values()], statusError: false }
  } catch {
    return { entries: [...entries.values()], statusError: true }
  }
}
export async function reloadMcpServers() {
  await rpc('config/mcpServer/reload')
}
export async function saveMcpServer(name: string, config: McpConfig | null) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid MCP server name')
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
