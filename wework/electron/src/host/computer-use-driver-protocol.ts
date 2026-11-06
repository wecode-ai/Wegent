import type { ToolResult } from '@trycua/cua-driver'

export type DriverRequest =
  | { id: number; method: 'start' }
  | { id: number; method: 'listTools' }
  | { id: number; method: 'shutdown' }
  | { id: number; method: 'callTool'; name: string; argumentsJson: string }
  | { id: number; method: 'abort' }

export type DriverResponse =
  | { id: number; ok: true; result?: string | ToolResult }
  | { id: number; ok: false; error: string }

/** Ignore unrelated Node IPC frames before they can enter the native dispatcher. */
export function isDriverRequest(value: unknown): value is DriverRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as Record<string, unknown>
  if (typeof request.id !== 'number' || !Number.isSafeInteger(request.id) || request.id <= 0)
    return false
  switch (request.method) {
    case 'start':
    case 'listTools':
    case 'shutdown':
    case 'abort':
      return true
    case 'callTool':
      return typeof request.name === 'string' && typeof request.argumentsJson === 'string'
    default:
      return false
  }
}
