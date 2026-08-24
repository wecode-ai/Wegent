interface RendererContents {
  executeJavaScript: (code: string) => Promise<unknown>
  isDestroyed: () => boolean
}

// Auxiliary renderers initialize their own auth, preferences, and workbench providers.
// On cold CI runners that can legitimately take longer than the window creation timeout
// used by the desktop host bridge. Keep the native window hidden until its real surface
// mounts, but retain a bounded failure so a broken route cannot hang the host forever.
const DEFAULT_RENDERER_READY_TIMEOUT_MS = 120_000
const RENDERER_READY_POLL_MS = 50

export async function waitForRendererSelector(
  contents: RendererContents,
  selector: string,
  timeoutMs = DEFAULT_RENDERER_READY_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const expression = `Boolean(document.querySelector(${JSON.stringify(selector)}))`
  while (!contents.isDestroyed()) {
    if (await contents.executeJavaScript(expression)) return
    if (Date.now() >= deadline) {
      throw new Error(`Renderer did not mount ${selector} within ${timeoutMs}ms`)
    }
    await new Promise(resolve => setTimeout(resolve, RENDERER_READY_POLL_MS))
  }
  throw new Error(`Renderer was destroyed before mounting ${selector}`)
}
