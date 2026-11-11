import type { WebContents } from 'electron'

/** Native frame access supports opaque/OOPIF pages without weakening their sandbox. */
export async function evaluateWorkbenchPage(
  contents: WebContents,
  expression: string
): Promise<unknown> {
  const main = contents.mainFrame
  const sandbox = main.frames.find(frame => frame.name === 'wework-workbench-lightweight')
  const frame = sandbox ?? main
  if (frame.isDestroyed() || frame.detached)
    throw new Error('Workbench page is no longer available')
  return frame.executeJavaScript(`(${expression})`, true)
}
