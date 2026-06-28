import type { DeviceCommandResponse } from '@/types/api'
import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/tauri/localExecutor'

export interface LocalRuntimeAuthStatus {
  runtime: 'codex'
  targetPath: string
  exists: boolean
  updatedAt: string | null
  sha256: string | null
  sizeBytes: number | null
  error: string | null
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function normalizeStatus(value: unknown): LocalRuntimeAuthStatus {
  const record = recordValue(value)
  return {
    runtime: 'codex',
    targetPath: typeof record.target_path === 'string' ? record.target_path : '~/.codex/auth.json',
    exists: record.exists === true,
    updatedAt: typeof record.updated_at === 'string' ? record.updated_at : null,
    sha256: typeof record.sha256 === 'string' ? record.sha256 : null,
    sizeBytes: typeof record.size_bytes === 'number' ? record.size_bytes : null,
    error: typeof record.error === 'string' ? record.error : null,
  }
}

export async function getLocalCodexAuthStatus(): Promise<LocalRuntimeAuthStatus> {
  await ensureLocalExecutorStarted()
  const response = await requestLocalExecutor<DeviceCommandResponse>('device.execute_command', {
    command_key: 'runtime_auth_status',
    timeout_seconds: 10,
    max_output_bytes: 4096,
  })
  if (!response.success) {
    throw new Error(response.error || response.stderr || 'Failed to read local Codex auth status')
  }
  return normalizeStatus(response.stdout)
}
