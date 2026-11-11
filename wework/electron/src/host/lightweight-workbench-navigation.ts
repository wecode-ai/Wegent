import type { WebContents, WebFrameMain } from 'electron'
import { LIGHTWEIGHT_WORKBENCH_FRAME_NAME } from './lightweight-workbench-client.js'
export { LIGHTWEIGHT_WORKBENCH_FRAME_NAME } from './lightweight-workbench-client.js'

const protectedContents = new WeakSet<WebContents>()

/** Keep the application's initial srcDoc document inside its Host-owned frame. */
export function protectLightweightWorkbenchFrames(contents: WebContents): void {
  if (protectedContents.has(contents)) return
  protectedContents.add(contents)
  const frames = new WeakSet<WebFrameMain>()
  const initialized = new WeakSet<WebFrameMain>()
  const protectedFrame = (frame: WebFrameMain | null | undefined): boolean => {
    if (!frame) return false
    if (frames.has(frame)) return true
    if (frame.name === LIGHTWEIGHT_WORKBENCH_FRAME_NAME || protectedFrame(frame.parent)) {
      frames.add(frame)
      return true
    }
    return false
  }
  contents.on('frame-created', (_event, { frame }) => {
    protectedFrame(frame)
  })
  contents.on('will-frame-navigate', event => {
    if (!protectedFrame(event.frame) && !protectedFrame(event.initiator)) return
    const frame = event.frame
    if (
      frame &&
      frames.has(frame) &&
      frame.name === LIGHTWEIGHT_WORKBENCH_FRAME_NAME &&
      !initialized.has(frame) &&
      ['', 'about:blank'].includes(frame.url) &&
      event.url === 'about:srcdoc' &&
      !protectedFrame(event.initiator)
    ) {
      initialized.add(frame)
      return
    }
    event.preventDefault()
  })
  contents.on('will-redirect', event => {
    if (protectedFrame(event.frame) || protectedFrame(event.initiator)) event.preventDefault()
  })
}
