interface PresentableWebContents {
  focus: () => void
  isDestroyed: () => boolean
}

export interface PresentableWindow {
  focus: () => void
  isDestroyed: () => boolean
  isMinimized: () => boolean
  moveTop: () => void
  restore: () => void
  show: () => void
  showInactive: () => void
  webContents: PresentableWebContents
}

export type WindowActivation = 'focus' | 'inactive'

export function createSingleFlight<T>(action: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null
  return () => {
    if (pending) return pending
    const current = action().finally(() => {
      if (pending === current) pending = null
    })
    pending = current
    return current
  }
}

export function presentWindow(
  target: PresentableWindow,
  activation: WindowActivation = 'focus'
): boolean {
  if (target.isDestroyed()) return false
  if (target.isMinimized()) target.restore()
  if (activation === 'inactive') {
    target.showInactive()
    target.moveTop()
    return true
  }
  target.show()
  target.focus()
  if (!target.webContents.isDestroyed()) target.webContents.focus()
  return true
}
