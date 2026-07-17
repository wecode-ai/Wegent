import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/tauri/localExecutor'
import type { DeviceCommandResponse } from '@/types/api'
import { isTauriRuntime } from './runtime-environment'

const BROWSER_TOOL_TIMEOUT_SECONDS = 30
const BROWSER_TOOL_MAX_OUTPUT_BYTES = 1024 * 1024

export interface CdpBrowserToolResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

export interface CdpBrowserPageState {
  faviconUrl: string | null
  title: string | null
  url: string | null
}

export interface CdpBrowserScreenshot {
  path: string
  size?: number
  type?: string
}

export interface CdpBrowserSession {
  targetId: string | null
  url: string
}

type BrowserToolPayload = Record<string, unknown> & {
  action: string
}

let relayStartPromise: Promise<void> | null = null

export function canUseCdpBrowserSession(): boolean {
  return isTauriRuntime()
}

function deviceCommandError(response: DeviceCommandResponse, fallback: string): Error | null {
  if (response.success) return null
  return new Error(response.error || response.stderr || fallback)
}

async function runDeviceCommand(
  commandKey: string,
  args: string[] = [],
  options: { timeoutSeconds?: number; maxOutputBytes?: number } = {}
): Promise<DeviceCommandResponse> {
  await ensureLocalExecutorStarted()
  return requestLocalExecutor<DeviceCommandResponse>('device.execute_command', {
    command_key: commandKey,
    args,
    timeout_seconds: options.timeoutSeconds ?? BROWSER_TOOL_TIMEOUT_SECONDS,
    max_output_bytes: options.maxOutputBytes ?? BROWSER_TOOL_MAX_OUTPUT_BYTES,
  })
}

async function ensureBrowserRelayStarted(): Promise<void> {
  if (!relayStartPromise) {
    relayStartPromise = runDeviceCommand('browser_relay_restart', [], {
      timeoutSeconds: 15,
      maxOutputBytes: 4096,
    })
      .then(response => {
        const error = deviceCommandError(response, 'Failed to start CDP browser relay')
        if (error) throw error
      })
      .finally(() => {
        relayStartPromise = null
      })
  }

  return relayStartPromise
}

function parseToolResult<T>(response: DeviceCommandResponse): CdpBrowserToolResult<T> {
  const stdout = response.stdout
  const toolResult =
    typeof stdout === 'object' && stdout !== null && !Array.isArray(stdout)
      ? (stdout as unknown as CdpBrowserToolResult<T>)
      : null

  if (toolResult) {
    if (!response.success && !toolResult.error) {
      return {
        ...toolResult,
        ok: false,
        error: response.error || response.stderr || 'Browser tool failed',
      }
    }
    return toolResult
  }

  return {
    ok: false,
    error: response.error || response.stderr || 'Browser tool returned an invalid response',
  }
}

export async function runCdpBrowserTool<T = unknown>(
  payload: BrowserToolPayload
): Promise<CdpBrowserToolResult<T>> {
  await ensureBrowserRelayStarted()
  const response = await runDeviceCommand('browser_tool', [JSON.stringify(payload)])
  return parseToolResult<T>(response)
}

function requireToolSuccess<T>(
  result: CdpBrowserToolResult<T>,
  fallback: string
): CdpBrowserToolResult<T> {
  if (!result.ok) {
    throw new Error(result.error || fallback)
  }
  return result
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function openCdpBrowserSession(url: string): Promise<CdpBrowserSession> {
  const result = requireToolSuccess(
    await runCdpBrowserTool<{ targetId?: string }>({
      action: 'open',
      ensure: true,
      url,
    }),
    'Failed to open CDP browser session'
  )
  const targetId = stringValue(recordValue(result.data).targetId)
  return { targetId, url }
}

export async function focusCdpBrowserSession(session: CdpBrowserSession): Promise<void> {
  if (!session.targetId) return
  requireToolSuccess(
    await runCdpBrowserTool({
      action: 'focus',
      targetId: session.targetId,
    }),
    'Failed to focus CDP browser session'
  )
}

export async function closeCdpBrowserSession(session: CdpBrowserSession): Promise<void> {
  if (!session.targetId) return
  await runCdpBrowserTool({
    action: 'close',
    targetId: session.targetId,
  }).catch(() => undefined)
}

export async function evaluateCdpBrowserSession<T = unknown>(
  session: CdpBrowserSession,
  expression: string
): Promise<T | null> {
  await focusCdpBrowserSession(session)
  const result = requireToolSuccess(
    await runCdpBrowserTool<T>({
      action: 'evaluate',
      expression,
    }),
    'Failed to evaluate CDP browser session'
  )
  return (result.data ?? null) as T | null
}

export async function navigateCdpBrowserSession(
  session: CdpBrowserSession,
  url: string
): Promise<CdpBrowserSession> {
  if (!session.targetId) return openCdpBrowserSession(url)
  await evaluateCdpBrowserSession(session, `window.location.assign(${JSON.stringify(url)}); true`)
  return { ...session, url }
}

export async function reloadCdpBrowserSession(session: CdpBrowserSession): Promise<void> {
  await evaluateCdpBrowserSession(session, 'window.location.reload(); true')
}

export async function resizeCdpBrowserSession(
  session: CdpBrowserSession,
  width: number,
  height: number
): Promise<void> {
  await focusCdpBrowserSession(session)
  requireToolSuccess(
    await runCdpBrowserTool({
      action: 'act',
      request: {
        kind: 'resize',
        width: Math.max(1, Math.floor(width)),
        height: Math.max(1, Math.floor(height)),
      },
    }),
    'Failed to resize CDP browser session'
  )
}

export async function clickCdpBrowserSession(
  session: CdpBrowserSession,
  x: number,
  y: number
): Promise<void> {
  await focusCdpBrowserSession(session)
  requireToolSuccess(
    await runCdpBrowserTool({
      action: 'act',
      request: {
        kind: 'clickAt',
        x,
        y,
      },
    }),
    'Failed to click CDP browser session'
  )
}

export async function insertTextCdpBrowserSession(
  session: CdpBrowserSession,
  text: string
): Promise<void> {
  await focusCdpBrowserSession(session)
  requireToolSuccess(
    await runCdpBrowserTool({
      action: 'act',
      request: {
        kind: 'insertText',
        text,
      },
    }),
    'Failed to type into CDP browser session'
  )
}

export async function pressKeyCdpBrowserSession(
  session: CdpBrowserSession,
  key: string
): Promise<void> {
  await focusCdpBrowserSession(session)
  requireToolSuccess(
    await runCdpBrowserTool({
      action: 'act',
      request: {
        kind: 'press',
        key,
      },
    }),
    'Failed to press key in CDP browser session'
  )
}

export async function goBackCdpBrowserSession(session: CdpBrowserSession): Promise<void> {
  await evaluateCdpBrowserSession(session, 'window.history.back(); true')
}

export async function goForwardCdpBrowserSession(session: CdpBrowserSession): Promise<void> {
  await evaluateCdpBrowserSession(session, 'window.history.forward(); true')
}

export async function readCdpBrowserPageState(
  session: CdpBrowserSession
): Promise<CdpBrowserPageState> {
  const state = await evaluateCdpBrowserSession<CdpBrowserPageState>(
    session,
    `(() => ({
      faviconUrl: Array.from(document.querySelectorAll('link[rel][href]'))
        .find((link) => /\\b(?:shortcut\\s+icon|icon|apple-touch-icon)\\b/i.test(link.rel))
        ?.href || new URL('/favicon.ico', window.location.href).href,
      title: document.title || null,
      url: window.location.href || null
    }))()`
  )

  return {
    faviconUrl: stringValue(state?.faviconUrl),
    title: stringValue(state?.title),
    url: stringValue(state?.url),
  }
}

export async function screenshotCdpBrowserSession(
  session: CdpBrowserSession
): Promise<CdpBrowserScreenshot | null> {
  await focusCdpBrowserSession(session)
  const result = requireToolSuccess(
    await runCdpBrowserTool<CdpBrowserScreenshot>({
      action: 'screenshot',
      type: 'jpeg',
    }),
    'Failed to capture CDP browser screenshot'
  )
  const path = stringValue(recordValue(result.data).path)
  if (!path) return null

  const data = recordValue(result.data)
  return {
    path,
    size: typeof data.size === 'number' ? data.size : undefined,
    type: stringValue(data.type) ?? undefined,
  }
}
