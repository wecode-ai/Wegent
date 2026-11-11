import type { WebContents } from 'electron'
import { LIGHTWEIGHT_WORKBENCH_FRAME_NAME } from './lightweight-workbench-client.js'

/** Native frame access supports opaque/OOPIF pages without weakening their sandbox. */
export async function evaluateWorkbenchPage(
  contents: WebContents,
  expression: string
): Promise<unknown> {
  const frame = contents.mainFrame.frames.find(
    candidate => candidate.name === LIGHTWEIGHT_WORKBENCH_FRAME_NAME
  )
  if (!frame) return contents.executeJavaScript(`(${expression})`, true)
  if (frame.isDestroyed() || frame.detached)
    throw new Error('Workbench page is no longer available')
  return frame.executeJavaScript(`(${expression})`, true)
}
