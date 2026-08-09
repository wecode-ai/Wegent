export type LocalHarnessId = 'opencode' | 'claude_code'

export type ClaudeCodePermissionMode = 'default' | 'plan' | 'bypass'

export interface LocalHarnessPreference {
  id: LocalHarnessId
  enabled: boolean
  executablePath: string | null
  args: string[]
  env: Record<string, string>
  permissionMode: ClaudeCodePermissionMode
}

export const LOCAL_HARNESS_IDS: LocalHarnessId[] = ['opencode', 'claude_code']

export const defaultLocalHarnessPreferences: LocalHarnessPreference[] = LOCAL_HARNESS_IDS.map(
  id => ({
    id,
    enabled: true,
    executablePath: null,
    args: [],
    env: {},
    permissionMode: 'default',
  })
)

export function localHarnessLabel(id: LocalHarnessId): string {
  return id === 'claude_code' ? 'Claude Code' : 'OpenCode'
}

export function normalizeLocalHarnessPreferences(value: unknown): LocalHarnessPreference[] {
  const records = Array.isArray(value) ? value : []
  return defaultLocalHarnessPreferences.map(defaultPreference => {
    const record = records.find(
      item =>
        item &&
        typeof item === 'object' &&
        (item as Partial<LocalHarnessPreference>).id === defaultPreference.id
    ) as Partial<LocalHarnessPreference> | undefined
    if (!record) return defaultPreference

    const executablePath =
      typeof record.executablePath === 'string' && record.executablePath.trim()
        ? record.executablePath.trim()
        : null
    const args = Array.isArray(record.args)
      ? record.args.flatMap(arg => (typeof arg === 'string' && arg ? [arg] : []))
      : []
    const env =
      record.env && typeof record.env === 'object' && !Array.isArray(record.env)
        ? Object.fromEntries(
            Object.entries(record.env).flatMap(([key, envValue]) =>
              key.trim() && typeof envValue === 'string' ? [[key.trim(), envValue]] : []
            )
          )
        : {}
    const permissionMode: ClaudeCodePermissionMode =
      defaultPreference.id === 'claude_code' &&
      (record.permissionMode === 'plan' || record.permissionMode === 'bypass')
        ? record.permissionMode
        : 'default'

    return {
      id: defaultPreference.id,
      enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
      executablePath,
      args,
      env,
      permissionMode,
    }
  })
}

export function buildLocalHarnessLaunchArgs(preference: LocalHarnessPreference): string[] {
  if (preference.id !== 'claude_code') return preference.args
  if (preference.permissionMode === 'plan') {
    return ['--permission-mode', 'plan', ...preference.args]
  }
  if (preference.permissionMode === 'bypass') {
    return ['--dangerously-skip-permissions', ...preference.args]
  }
  return preference.args
}

export function parseLocalHarnessArgs(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(arg => arg.trim())
    .filter(Boolean)
}

export function formatLocalHarnessArgs(args: string[]): string {
  return args.join('\n')
}

export function parseLocalHarnessEnv(value: string): {
  env: Record<string, string>
  error: string | null
} {
  const env: Record<string, string> = {}
  for (const [index, rawLine] of value.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line) continue
    const separator = line.indexOf('=')
    const key = separator < 0 ? '' : line.slice(0, separator).trim()
    if (!key || key.includes('\0')) {
      return { env: {}, error: `line:${index + 1}` }
    }
    const envValue = line.slice(separator + 1)
    if (envValue.includes('\0')) {
      return { env: {}, error: `line:${index + 1}` }
    }
    env[key] = envValue
  }
  return { env, error: null }
}

export function formatLocalHarnessEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}
