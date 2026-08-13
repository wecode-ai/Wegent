import type { DeviceCommandResponse } from '@/types/api'
import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/tauri/localExecutor'

export type GitHostingCliProvider = 'github' | 'gitlab'

export interface GitHostingCliStatus {
  provider: GitHostingCliProvider
  tool: 'gh' | 'glab'
  installed: boolean
  authenticated: boolean
  executablePath: string | null
  version: string | null
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function normalizeStatus(provider: GitHostingCliProvider, value: unknown): GitHostingCliStatus {
  const record = recordValue(value)
  return {
    provider,
    tool: provider === 'github' ? 'gh' : 'glab',
    installed: record.installed === true,
    authenticated: record.authenticated === true,
    executablePath:
      typeof record.executablePath === 'string' && record.executablePath.trim()
        ? record.executablePath.trim()
        : null,
    version:
      typeof record.version === 'string' && record.version.trim() ? record.version.trim() : null,
  }
}

export async function getGitHostingCliStatus(
  provider: GitHostingCliProvider
): Promise<GitHostingCliStatus> {
  await ensureLocalExecutorStarted()
  const response = await requestLocalExecutor<DeviceCommandResponse>('device.execute_command', {
    command_key: provider === 'github' ? 'git_github_cli_status' : 'git_gitlab_cli_status',
    timeout_seconds: 15,
    max_output_bytes: 8192,
  })
  if (!response.success) {
    throw new Error(response.error || response.stderr || 'Failed to detect Git hosting CLI')
  }
  return normalizeStatus(provider, response.stdout)
}
