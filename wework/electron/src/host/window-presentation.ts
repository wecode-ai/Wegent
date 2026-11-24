import { app, BrowserWindow } from 'electron'
import {
  captureWindowActivationSnapshotSafe,
  logWindowActivation,
  noteWindowActivationRequest,
  takeCorrelatedActivationRequest,
  type WindowActivationElectron,
  type WindowActivationInitiator,
} from './window-activation-diagnostics.js'

interface PresentableWebContents {
  focus: () => void
  isDestroyed: () => boolean
}

export interface PresentableWindow {
  focus: () => void
  id?: number
  isDestroyed: () => boolean
  isFocused?: () => boolean
  isMinimized: () => boolean
  isVisible?: () => boolean
  restore: () => void
  show: () => void
  webContents: PresentableWebContents
}

export interface PresentationInfo {
  reason: string
  initiator: WindowActivationInitiator
  userInitiated: boolean | null
  target?: string
  agentActive?: boolean
}

const activationElectron: WindowActivationElectron = { app, BrowserWindow }

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
    const correlated = takeCorrelatedActivationRequest()
    // An activation without a recent programmatic request is an external or
    // user switch (Cmd+Tab, LaunchServices, system resume). It must never
    // produce a focus-steal diagnostic line; only a correlated activation
    // confirms that a presentation request reached the OS, and it keeps the
    // original request's initiator instead of guessing one here.
    if (correlated) {
      logWindowActivation(
        {
          reason: 'did-become-active',
          initiator: correlated.initiator,
          userInitiated: correlated.userInitiated,
          target: correlated.target,
          correlationId: correlated.correlationId,
          activationOutcome: 'requested',
          requestedReason: correlated.reason,
        },
        captureWindowActivationSnapshotSafe(activationElectron)
      )
    }
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

export function presentWindow(target: PresentableWindow, info: PresentationInfo): boolean {
  if (target.isDestroyed()) return false
  const before = captureWindowActivationSnapshotSafe(activationElectron, target)
  let correlationId: string | undefined
  if (before && before.appActive === false) {
    try {
      // macOS may deliver did-become-active synchronously during focus(), so
      // the correlation request must be registered before the presentation.
      // Only an app that was inactive before the presentation may register
      // one; while the app is already active the before/after snapshots carry
      // the evidence, and an unrelated user switch inside the correlation
      // window must not be misattributed to this presentation.
      correlationId = noteWindowActivationRequest({
        reason: info.reason,
        initiator: info.initiator,
        userInitiated: info.userInitiated,
        target: info.target,
      })
    } catch {
      correlationId = undefined
    }
  }
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
  if (!target.webContents.isDestroyed()) target.webContents.focus()
  // macOS settles asynchronously: capture the after snapshot and emit the
  // line one event-loop tick later, inside the diagnostics safety boundary.
  const settleTimer = setTimeout(() => {
    logWindowActivation(
      {
        reason: info.reason,
        initiator: info.initiator,
        userInitiated: info.userInitiated,
        target: info.target,
        agentActive: info.agentActive,
        correlationId,
      },
      before,
      captureWindowActivationSnapshotSafe(activationElectron, target)
    )
  }, 0)
  settleTimer.unref()
  return true
}

export function presentWorkbenchWindow<T extends PresentableWindow>(
  preferredWindow: T | null,
  mainWindow: T | null,
  info: PresentationInfo
): T | null {
  if (preferredWindow && presentWindow(preferredWindow, info)) return preferredWindow
  return mainWindow && mainWindow !== preferredWindow && presentWindow(mainWindow, info)
    ? mainWindow
    : null
}
