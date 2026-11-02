/**
 * Background execution policy for workbench windows.
 *
 * Wework keeps its local runtime responsive while a window is covered or
 * minimized. Electron's per-window `backgroundThrottling: false` provides that
 * on macOS and Linux, but on Windows it also leaves the native renderer input
 * HWND hidden after occlusion or minimize. Chromium then delivers precision
 * touchpad gestures as mouse-wheel deltas, so scrolling becomes several times
 * faster (https://github.com/electron/electron/issues/54694).
 *
 * Windows therefore keeps the default visibility lifecycle, which restores the
 * input HWND, and disables only background timer throttling so pending
 * workbench work keeps running while the window is not visible.
 */

export const BACKGROUND_TIMER_THROTTLING_SWITCH = 'disable-background-timer-throttling'

/** Value for `webPreferences.backgroundThrottling`; `false` keeps background work live. */
export function workbenchBackgroundThrottling(platform: NodeJS.Platform): boolean {
  return platform === 'win32'
}

export function applyWorkbenchBackgroundPolicy(
  platform: NodeJS.Platform,
  commandLine: { appendSwitch: (name: string) => void }
): void {
  if (!workbenchBackgroundThrottling(platform)) return
  commandLine.appendSwitch(BACKGROUND_TIMER_THROTTLING_SWITCH)
}
