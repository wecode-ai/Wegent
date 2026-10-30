import type { BrowserWindow } from 'electron'

export async function inspectStartupSplash(
  window: BrowserWindow | null
): Promise<Record<string, unknown>> {
  if (!window || window.isDestroyed()) throw new Error('Startup splash is unavailable')
  return window.webContents.executeJavaScript(`(() => {
    const text = id => document.getElementById(id)?.textContent ?? ''
    const hidden = id => document.getElementById(id)?.hidden ?? true
    const activity = document.getElementById('splash-activity')
    const style = activity ? getComputedStyle(activity) : null
    const progress = document.getElementById('splash-progress')
    return {
      title: text('splash-title'),
      stepCount: text('splash-step-count'),
      activity: activity?.textContent ?? '',
      activityAriaHidden: activity?.getAttribute('aria-hidden'),
      activityColor: style?.color,
      activityFontSize: style?.fontSize,
      slowHidden: hidden('startup-slow'),
      timeoutHidden: hidden('startup-timeout'),
      timeoutTitle: text('startup-timeout-title'),
      timeoutActionsHidden: hidden('startup-timeout-actions'),
      failureHidden: hidden('startup-failure'),
      recoveryHidden: hidden('startup-recovery'),
      toastText: text('startup-toast'),
      progressClassName: progress?.className,
      progressNow: progress?.getAttribute('aria-valuenow'),
    }
  })()`)
}

export async function clickStartupSplash(
  window: BrowserWindow | null,
  testId: string
): Promise<void> {
  if (!window || window.isDestroyed()) throw new Error('Startup splash is unavailable')
  const position = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-testid=' + ${JSON.stringify(JSON.stringify(testId))} + ']')
    if (!button || button.disabled || !button.checkVisibility()) return null
    const bounds = button.getBoundingClientRect()
    return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }
  })()`)
  if (!position) throw new Error(`Startup splash action is unavailable: ${testId}`)
  window.webContents.sendInputEvent({ type: 'mouseMove', ...position })
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...position,
  })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position })
}
