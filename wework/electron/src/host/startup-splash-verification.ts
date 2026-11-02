import type { BrowserWindow } from 'electron'
import type { StartupProgressUpdate } from './startup-progress.js'

export interface StartupSplashInspection extends Record<string, unknown> {
  progress: StartupProgressUpdate | null
}

/** Records the real splash before the workbench control client can connect. */
export function observeStartupSplash(
  window: BrowserWindow,
  inspect: () => Promise<StartupSplashInspection>
): { inspect: () => Promise<Record<string, unknown>> } {
  const observations: StartupSplashInspection[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let failure: unknown
  let previousState: string | undefined
  const stop = () => {
    stopped = true
    clearTimeout(timer)
  }
  window.once('closed', stop)
  const sample = async () => {
    try {
      const snapshot = await inspect()
      if (stopped) return
      const state = JSON.stringify([
        snapshot.progress?.stage.id,
        snapshot.progress?.startedAt,
        snapshot.stepCount,
        snapshot.title,
        snapshot.slowHidden,
        snapshot.timeoutHidden,
        snapshot.failureHidden,
        snapshot.recoveryHidden,
      ])
      if (state !== previousState) {
        observations.push({ ...snapshot, capturedAt: Date.now() })
        if (observations.length > 64) observations.shift()
        previousState = state
      }
      timer = setTimeout(() => void sample(), 50)
      timer.unref()
    } catch (error) {
      if (!stopped) failure = error
      stop()
    }
  }
  void sample()
  return {
    inspect: async () => {
      if (failure) throw failure
      return { ...(await inspect()), observations: [...observations] }
    },
  }
}

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
      toastHidden: hidden('startup-toast'),
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
