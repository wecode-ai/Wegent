import type { WebContents } from 'electron'
import { HostCapabilityError } from './capability-router.js'

const CAPTURE_ATTEMPT_TIMEOUT_MS = 10_000

export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

export interface WebContentsCaptureOptions {
  rect?: CaptureRect
  preferDebugger?: boolean
}

export async function captureWebContentsDataUrl(
  contents: WebContents,
  options: WebContentsCaptureOptions = {}
): Promise<string> {
  const attempts = options.preferDebugger
    ? [
        {
          label: 'CDP Page.captureScreenshot',
          capture: () => captureDebugger(contents, false, options.rect),
        },
        {
          label: 'Electron capturePage',
          capture: () => captureNative(contents, options.rect),
        },
      ]
    : [
        {
          label: 'Electron capturePage',
          capture: () => captureNative(contents, options.rect),
        },
        {
          label: 'CDP Page.captureScreenshot',
          capture: () => captureDebugger(contents, true, options.rect),
        },
      ]
  const failures: string[] = []
  for (const attempt of attempts) {
    try {
      return await attempt.capture()
    } catch (error) {
      failures.push(`${attempt.label} failed: ${errorMessage(error)}`)
    }
  }
  throw new HostCapabilityError('e2e_capture_failed', failures.join('; '))
}

async function captureDebugger(
  contents: WebContents,
  fromSurface: boolean,
  rect?: CaptureRect
): Promise<string> {
  const debugSession = contents.debugger
  const alreadyAttached = debugSession.isAttached()
  try {
    if (!alreadyAttached) debugSession.attach()
    const result = (await withCaptureTimeout(
      debugSession.sendCommand('Page.captureScreenshot', {
        captureBeyondViewport: false,
        format: 'png',
        fromSurface,
        ...(rect ? { clip: { ...rect, scale: 1 } } : {}),
      }),
      'CDP Page.captureScreenshot'
    )) as { data?: unknown }
    if (typeof result.data === 'string' && result.data.length > 0) {
      return `data:image/png;base64,${result.data}`
    }
    throw new Error('CDP returned an empty screenshot')
  } finally {
    if (!alreadyAttached && debugSession.isAttached()) debugSession.detach()
  }
}

async function captureNative(contents: WebContents, rect?: CaptureRect): Promise<string> {
  const image = await withCaptureTimeout(contents.capturePage(rect), 'Electron capturePage')
  if (!image.isEmpty()) {
    const dataUrl = image.toDataURL()
    if (dataUrl.length > 'data:image/png;base64,'.length) return dataUrl
  }
  throw new Error('Electron returned an empty screenshot')
}

function withCaptureTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${CAPTURE_ATTEMPT_TIMEOUT_MS}ms`))
    }, CAPTURE_ATTEMPT_TIMEOUT_MS)
    promise.then(resolve, reject).finally(() => clearTimeout(timeout))
  })
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return error == null ? 'returned an empty image' : String(error)
}
