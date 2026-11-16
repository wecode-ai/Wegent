import { waitForClosedStartupSplash } from './native-window-state.mjs'

export async function restartCloudConfigDesktop(control, restartDesktopApp, timeoutMs, options) {
  await restartDesktopApp(options)
  // Reconnecting the controller precedes the native startup window handoff.
  return waitForClosedStartupSplash(
    {
      command: (action, selector) => control.command(action, selector, { timeoutMs }),
    },
    timeoutMs
  )
}
