import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { FeedbackApi } from './TaskFeedbackDialog'

export interface FeedbackDialogRequest {
  hasActiveTask: boolean
  /** Identifies the task whose context is attached; null for a non-task surface. */
  deviceId?: string | null
  taskId?: string | null
  getTaskContext: () => Promise<Record<string, unknown>>
  feedbackApi?: FeedbackApi
}

export type FeedbackDialogContextProvider = () => FeedbackDialogRequest

export const EMPTY_FEEDBACK_DIALOG_REQUEST: FeedbackDialogRequest = {
  hasActiveTask: false,
  deviceId: null,
  taskId: null,
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
 * Opens the single feedback dialog. The selected task and request fields are
 * frozen for the lifetime of the open dialog so switching surfaces cannot
 * replace a form the user has already started filling in. The registered
 * context refreshes only the task-context getter for the same task.
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
    return registerFeedbackDialogContext(() =>
      withLatestFeedbackDialogContext(requestRef.current, () => requestRef.current)
    )
  }, [active])
}

/**
 * Freezes the selected task and request fields while allowing the task-context
 * getter to follow the same task's latest runtime state.
 */
export function withLatestFeedbackDialogContext(
  openedRequest: FeedbackDialogRequest,
  getLatestRequest: () => FeedbackDialogRequest
): FeedbackDialogRequest {
  return {
    ...openedRequest,
    getTaskContext: () => {
      const latestRequest = getLatestRequest()
      return hasSameTaskIdentity(openedRequest, latestRequest)
        ? latestRequest.getTaskContext()
        : openedRequest.getTaskContext()
    },
  }
}

function hasSameTaskIdentity(left: FeedbackDialogRequest, right: FeedbackDialogRequest): boolean {
  return left.deviceId === right.deviceId && left.taskId === right.taskId
}
