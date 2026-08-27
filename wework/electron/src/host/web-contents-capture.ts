import type { WebContents } from 'electron'
import { HostCapabilityError } from './capability-router.js'

export async function captureWebContentsDataUrl(contents: WebContents): Promise<string> {
  let nativeCaptureError: unknown = null
  try {
    const image = await contents.capturePage()
    if (!image.isEmpty()) {
      const dataUrl = image.toDataURL()
      if (dataUrl.length > 'data:image/png;base64,'.length) return dataUrl
    }
  } catch (error) {
    nativeCaptureError = error
  }

  const debugSession = contents.debugger
  const alreadyAttached = debugSession.isAttached()
  if (!alreadyAttached) debugSession.attach()
  try {
    let result: { data?: unknown }
    try {
      result = (await debugSession.sendCommand('Page.captureScreenshot', {
        captureBeyondViewport: false,
        format: 'png',
        fromSurface: true,
      })) as { data?: unknown }
    } catch (error) {
      throw new HostCapabilityError(
        'e2e_capture_failed',
        [
          `Electron capturePage failed: ${errorMessage(nativeCaptureError)}`,
          `CDP Page.captureScreenshot failed: ${errorMessage(error)}`,
        ].join('; ')
      )
    }
    if (typeof result.data !== 'string' || result.data.length === 0) {
      throw new HostCapabilityError('e2e_capture_failed', 'Electron returned an empty screenshot')
    }
    return `data:image/png;base64,${result.data}`
  } finally {
    if (!alreadyAttached && debugSession.isAttached()) debugSession.detach()
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return error == null ? 'returned an empty image' : String(error)
}
