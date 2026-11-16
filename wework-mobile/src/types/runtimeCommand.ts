/** Existing PC device.execute_command request and response contract. */
export interface RuntimeDeviceCommandRequest {
  command_key: string
  path?: string
  cwd?: string
  args?: string[]
  env?: Record<string, unknown>
  timeout_seconds?: number
  max_output_bytes?: number
}

export interface RuntimeDeviceCommandResponse {
  success: boolean
  exit_code?: number | null
  stdout: string | Record<string, unknown> | unknown[]
  stderr?: string
  error?: string | null
  duration?: number
  timed_out?: boolean
  stdout_truncated?: boolean
  stderr_truncated?: boolean
}
