import { randomUUID } from 'node:crypto'
import type { SmartAppVerificationIssue } from './smart-app-verification-types.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 50

export interface SmartAppVerificationContents {
  loadURL(url: string): Promise<void>
  executeJavaScript(code: string): Promise<unknown>
  isDestroyed(): boolean
}

export interface SmartAppVerificationViewHandle {
  contents: SmartAppVerificationContents
  dispose(): Promise<void>
}

export interface VerifySmartAppPageOptions {
  baseUrl: string
  path: string
  readySelector: string
  timeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
  createView?: (partition: string) => Promise<SmartAppVerificationViewHandle>
}

export interface SmartAppVerificationViewResult {
  issues: SmartAppVerificationIssue[]
}

export async function verifySmartAppPage(
  options: VerifySmartAppPageOptions
): Promise<SmartAppVerificationViewResult> {
  const target = sameOriginTarget(options.baseUrl, options.path)
  if (!target) return { issues: [runtimeIssue('SA-RUNTIME-PATH', 'Runtime path changes origin')] }
  const createView = options.createView ?? createElectronVerificationView
  const view = await createView(`smart-app-verification-${randomUUID()}`)
  try {
    try {
      await view.contents.loadURL(target)
    } catch {
      return {
        issues: [runtimeIssue('SA-RUNTIME-NAVIGATION', 'Smart App runtime page did not load')],
      }
    }
    return await waitForReadySelector(view.contents, options)
  } finally {
    await view.dispose().catch(() => {})
  }
}

async function waitForReadySelector(
  contents: SmartAppVerificationContents,
  options: VerifySmartAppPageOptions
): Promise<SmartAppVerificationViewResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  const expression = `Boolean(document.querySelector(${JSON.stringify(options.readySelector)}))`
  while (!contents.isDestroyed()) {
    if (options.signal?.aborted) {
      return {
        issues: [runtimeIssue('SA-RUNTIME-CANCELLED', 'Runtime verification was cancelled')],
      }
    }
    try {
      if (await contents.executeJavaScript(expression)) return { issues: [] }
    } catch {
      return {
        issues: [runtimeIssue('SA-RUNTIME-SELECTOR', 'Runtime ready selector is invalid')],
      }
    }
    if (Date.now() >= deadline) {
      return {
        issues: [
          runtimeIssue(
            'SA-RUNTIME-READY-TIMEOUT',
            `Runtime ready selector did not appear within ${timeoutMs}ms`
          ),
        ],
      }
    }
    await delay(pollIntervalMs)
  }
  return { issues: [runtimeIssue('SA-RUNTIME-VIEW-CLOSED', 'Runtime page closed before ready')] }
}

async function createElectronVerificationView(
  partition: string
): Promise<SmartAppVerificationViewHandle> {
  const { BrowserWindow, session } = await import('electron')
  const isolatedSession = session.fromPartition(partition, { cache: false })
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: isolatedSession,
    },
  })
  return {
    contents: window.webContents,
    async dispose() {
      if (!window.isDestroyed()) window.destroy()
      await isolatedSession.clearCache()
      await isolatedSession.clearStorageData()
    },
  }
}

function sameOriginTarget(baseUrl: string, path: string): string | null {
  try {
    const base = new URL(baseUrl)
    const target = new URL(path, base)
    return target.origin === base.origin ? target.toString() : null
  } catch {
    return null
  }
}

function runtimeIssue(code: string, message: string): SmartAppVerificationIssue {
  return {
    code,
    stage: 'runtime',
    file: null,
    message,
    expected: null,
    actual: null,
    blocking: true,
    hint: null,
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}
