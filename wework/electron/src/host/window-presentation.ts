interface PresentableWebContents {
  focus: () => void
  isDestroyed: () => boolean
}

export interface PresentableWindow {
  focus: () => void
  isDestroyed: () => boolean
  isMinimized: () => boolean
  restore: () => void
  show: () => void
  webContents: PresentableWebContents
}

export function registerApplicationActivation(
  application: {
    on(event: 'activate', listener: () => void): unknown
    on(event: 'did-become-active', listener: () => void): unknown
    hide: () => void
  },
  actions: {
    keepInBackground: () => boolean
    openMainWindow: () => Promise<void>
    reportError: (error: unknown) => void
  }
) {
  application.on('activate', () => {
    if (actions.keepInBackground()) return
    void actions.openMainWindow().catch(actions.reportError)
  })
  application.on('did-become-active', () => {
    // Focusing an auxiliary window also activates the app, without requesting the main window.
    if (actions.keepInBackground()) application.hide()
  })
}

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

export function presentWindow(target: PresentableWindow): boolean {
  if (target.isDestroyed()) return false
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
  if (!target.webContents.isDestroyed()) target.webContents.focus()
  return true
}
