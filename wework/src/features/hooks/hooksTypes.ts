export type HookSource = 'user' | 'bundled' | 'managed'
export type HookHealthStatus =
  | 'ready'
  | 'disabled'
  | 'invalid_config'
  | 'missing_command'
  | 'not_executable'
  | 'unsupported'
  | 'duplicate_plugin_id'

export interface HookPolicy {
  canDisable: boolean
  canEdit: boolean
  canDelete: boolean
}
export interface HookManifest {
  schemaVersion: number
  id: string
  name: string
  description: string
  version: string
}
export interface CommandHookConfig {
  type: 'command'
  command: string
  commandWindows?: string
  commands?: Record<string, string>
  timeout: number
  async: boolean
  statusMessage?: string
}
export interface HookHandler {
  id: string
  matcher: string
  config: CommandHookConfig
}
export interface HookRunSummary {
  runId: string
  pluginId: string
  handlerId: string
  status: 'succeeded' | 'failed' | 'timed_out' | 'skipped_capacity'
  startedAtMs: number
  durationMs: number
  exitCode?: number
  stdoutPreview: string
  stderrPreview: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}
export interface ResolvedHookPlugin {
  manifest: HookManifest
  enabled: boolean
  source: HookSource
  installPath: string
  policy: HookPolicy
  health: { status: HookHealthStatus; message?: string } | HookHealthStatus
  handlers: HookHandler[]
  recentRuns: HookRunSummary[]
}
export interface HookDraft {
  manifest: HookManifest
  hooks: { PostToolUse: Array<{ matcher: string; hooks: CommandHookConfig[] }> }
}
