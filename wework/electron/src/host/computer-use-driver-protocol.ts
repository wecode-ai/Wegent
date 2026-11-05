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
