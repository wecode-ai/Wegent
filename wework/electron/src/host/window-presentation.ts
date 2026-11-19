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
    openWorkbenchWindow: () => Promise<void>
    reportError: (error: unknown) => void
  }
) {
  application.on('activate', () => {
    if (actions.keepInBackground()) return
    void actions.openWorkbenchWindow().catch(actions.reportError)
  })
  application.on('did-become-active', () => {
    // Focusing an auxiliary window activates the app without a Dock reopen request.
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

export function presentWorkbenchWindow<T extends PresentableWindow>(
  preferredWindow: T | null,
  mainWindow: T | null
): T | null {
  if (preferredWindow && presentWindow(preferredWindow)) return preferredWindow
  return mainWindow && mainWindow !== preferredWindow && presentWindow(mainWindow)
    ? mainWindow
    : null
}
