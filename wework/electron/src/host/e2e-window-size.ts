import type { BrowserWindow } from 'electron'

type ResizableWindow = Pick<
  BrowserWindow,
  | 'getContentSize'
  | 'isDestroyed'
  | 'isMaximized'
  | 'on'
  | 'removeListener'
  | 'setContentSize'
  | 'unmaximize'
>

function waitForNativeSizeState(
  target: ResizableWindow,
  change: () => void,
  complete: () => boolean,
  expected: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      target.removeListener('unmaximize', changed)
      target.removeListener('resize', changed)
      target.removeListener('closed', closed)
    }
    const failed = (error: unknown) => {
      cleanup()
      reject(error)
    }
    const closed = () => failed(new Error('The E2E window closed while resizing'))
    const changed = () => {
      try {
        if (target.isDestroyed()) return closed()
        if (!complete()) return
        cleanup()
        resolve()
      } catch (error) {
        failed(error)
      }
    }
    const timeout = setTimeout(() => {
      try {
        if (target.isDestroyed()) return closed()
        failed(
          new Error(
            `The E2E window did not ${expected}; actual content=${target.getContentSize().join('x')}, maximized=${target.isMaximized()}`
          )
        )
      } catch (error) {
        failed(error)
      }
    }, 5000)
    target.on('unmaximize', changed)
    target.on('resize', changed)
    target.on('closed', closed)
    try {
      if (target.isDestroyed()) return closed()
      change()
      changed()
    } catch (error) {
      failed(error)
    }
  })
}

/** Acknowledge explicit E2E sizes only after the window manager applies them. */
export async function setE2EWindowSize(
  target: ResizableWindow,
  width: number,
  height: number
): Promise<{ width: number; height: number }> {
  if (target.isDestroyed()) throw new Error('The E2E window is unavailable for resizing')
  const [previousWidth, previousHeight] = target.getContentSize()
  if (target.isMaximized()) {
    await waitForNativeSizeState(
      target,
      () => target.unmaximize(),
      () => !target.isMaximized(),
      'leave the maximized state'
    )
  }
  await waitForNativeSizeState(
    target,
    () => target.setContentSize(width, height),
    () => {
      const [actualWidth, actualHeight] = target.getContentSize()
      return !target.isMaximized() && actualWidth === width && actualHeight === height
    },
    `resize its content to ${width}x${height}`
  )
  return { width: previousWidth, height: previousHeight }
}
