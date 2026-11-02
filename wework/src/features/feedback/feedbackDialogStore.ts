import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { FeedbackApi } from './TaskFeedbackDialog'

export interface FeedbackDialogRequest {
  hasActiveTask: boolean
  getTaskContext: () => Promise<Record<string, unknown>>
  feedbackApi?: FeedbackApi
}

export type FeedbackDialogContextProvider = () => FeedbackDialogRequest

export const EMPTY_FEEDBACK_DIALOG_REQUEST: FeedbackDialogRequest = {
  hasActiveTask: false,
  getTaskContext: () => Promise.resolve({}),
}

interface FeedbackDialogContextRegistration {
  provider: FeedbackDialogContextProvider
}

let activeRequest: FeedbackDialogRequest | null = null
let registeredContext: FeedbackDialogContextRegistration | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): FeedbackDialogRequest | null {
  return activeRequest
}

/**
 * Opens the single feedback dialog. The request is frozen for the lifetime of
 * the open dialog so switching surfaces cannot replace a form the user has
 * already started filling in.
 */
export function openFeedbackDialog(request?: FeedbackDialogRequest): void {
  if (activeRequest) return
  activeRequest = request ?? registeredContext?.provider() ?? EMPTY_FEEDBACK_DIALOG_REQUEST
  emit()
}

export function closeFeedbackDialog(): void {
  if (!activeRequest) return
  activeRequest = null
  emit()
}

/**
 * Registers the active task surface's feedback context. Registration only
 * affects the next open request; it never mutates an already open dialog.
 */
export function registerFeedbackDialogContext(provider: FeedbackDialogContextProvider): () => void {
  const registration: FeedbackDialogContextRegistration = { provider }
  registeredContext = registration
  return () => {
    if (registeredContext === registration) registeredContext = null
  }
}

export function useFeedbackDialogRequest(): FeedbackDialogRequest | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null)
}

/**
 * Keeps the latest request in a ref and registers it while the owning surface
 * is active. The ref keeps the registration stable across task updates.
 */
export function useRegisteredFeedbackDialogContext(
  active: boolean,
  request: FeedbackDialogRequest
): void {
  const requestRef = useRef(request)

  useLayoutEffect(() => {
    requestRef.current = request
  }, [request])

  useLayoutEffect(() => {
    if (!active) return
    return registerFeedbackDialogContext(() => requestRef.current)
  }, [active])
}
