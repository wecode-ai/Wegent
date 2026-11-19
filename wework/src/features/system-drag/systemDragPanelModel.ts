import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'

export type DropAction = 'new-chat' | 'follow-up' | 'stash'
type DropStatus = { kind: 'success' | 'error'; action: DropAction } | null
type PanelContext = { conversationTitle: string | null; presentationId: number | null }
const FEEDBACK_DURATION_MS = 800
const DROP_DEDUP_WINDOW_MS = 500

/** Host presentation identity outlives the renderer's reused native window. */
export function createSystemDragPanelModel() {
  const readContext = () => invokeDesktopHost<PanelContext>('systemDrag.getContext')
  const context = createAsyncResource('system-drag-context', readContext, {
    refreshOnSubscribe: true,
    failure(error) {
      console.error('[Wework] Failed to read system drag context:', error)
    },
  })
  const listeners = new Set<() => void>()
  let activeAction: DropAction | null = null
  let dropStatus: DropStatus = null
  let lastDrop: { key: string; timestamp: number } | null = null
  let presentationId: number | null = null
  let generation = 0
  let captureSequence = 0
  let pendingDrop = Promise.resolve()
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined
  let stopContext: (() => void) | undefined
  let stopEvents: (() => void) | undefined
  const read = () => ({
    activeAction,
    dropStatus,
    conversationTitle: context.getSnapshot().data?.conversationTitle ?? null,
  })
  let snapshot = read()
  const publish = () => {
    snapshot = read()
    listeners.forEach(listener => listener())
  }
  const cancelFeedback = () => {
    clearTimeout(feedbackTimer)
    feedbackTimer = undefined
  }
  const onContext = () => {
    const next = context.getSnapshot().data
    if (next && next.presentationId !== presentationId) {
      // Initial context resolution may confirm the first drop's owner. A known
      // presentation changing must invalidate every drop already queued for it.
      if (presentationId !== null) {
        captureSequence += 1
        pendingDrop = Promise.resolve()
      }
      presentationId = next.presentationId
      generation += 1
      cancelFeedback()
      dropStatus = null
      activeAction = null
      lastDrop = null
    }
    publish()
  }
  const dismissHost = async (id: number) => {
    try {
      return await invokeDesktopHost<boolean>('systemDrag.dismissPanel', { presentationId: id })
    } catch (error) {
      console.error('[Wework] Failed to dismiss system drag panel:', error)
      return false
    }
  }
  const isCurrent = (owner: number, id: number) =>
    listeners.size > 0 && owner === generation && presentationId === id
  const complete = async (
    action: DropAction,
    text: string | null,
    paths: string[],
    owner: number,
    id: number
  ) => {
    let result: NonNullable<DropStatus>['kind']
    try {
      const accepted = await invokeDesktopHost<boolean>('systemDrag.complete', {
        payload: { action, text, paths },
        presentationId: id,
      })
      if (!accepted) return
      result = 'success'
    } catch (error) {
      console.error('[Wework] Failed to complete system drop:', error)
      result = 'error'
    }
    if (!isCurrent(owner, id)) return
    try {
      const current = await readContext()
      if (!isCurrent(owner, id)) return
      context.update(() => current)
      if (!isCurrent(owner, id)) return
    } catch (error) {
      console.error('[Wework] Failed to read system drag context:', error)
      return
    }
    dropStatus = { kind: result, action }
    publish()
    feedbackTimer = setTimeout(() => {
      feedbackTimer = undefined
      if (!isCurrent(owner, id)) return
      void dismissHost(id).then(dismissed => {
        if (!dismissed || !isCurrent(owner, id)) return
        dropStatus = null
        activeAction = null
        publish()
      })
    }, FEEDBACK_DURATION_MS)
  }
  const captureDrop = async (
    action: DropAction,
    text: string,
    paths: string[],
    timestamp: number,
    owner: number,
    expectedPresentationId: number | null
  ) => {
    if (!listeners.size || owner !== captureSequence) return
    try {
      const current = await readContext()
      if (!listeners.size || owner !== captureSequence) return
      if (
        current.presentationId !== null &&
        presentationId !== null &&
        current.presentationId < presentationId
      )
        return
      context.update(() => current)
      if (!listeners.size || owner !== captureSequence) return
      const id = current.presentationId
      if (id === null || (expectedPresentationId !== null && id !== expectedPresentationId)) return
      const key = `${action}:${text}:${paths.join('\0')}`
      if (lastDrop?.key === key && timestamp - lastDrop.timestamp < DROP_DEDUP_WINDOW_MS) return
      lastDrop = { key, timestamp }
      generation += 1
      cancelFeedback()
      activeAction = action
      publish()
      void complete(action, text || null, paths, generation, id)
    } catch (error) {
      console.error('[Wework] Failed to read system drag context:', error)
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (!stopContext) {
        stopContext = context.subscribe(onContext)
        stopEvents = subscribeDesktopHostEvents(event => {
          if (event.type !== 'systemDrag.context') return
          const { presentationId: id, conversationTitle } = event.payload
          if (
            typeof id === 'number' &&
            Number.isSafeInteger(id) &&
            id > 0 &&
            (conversationTitle === null || typeof conversationTitle === 'string')
          ) {
            if (presentationId !== null && id < presentationId) return
            context.update(() => ({ presentationId: id, conversationTitle }))
          } else {
            void context.reload()
          }
        })
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        generation += 1
        captureSequence += 1
        pendingDrop = Promise.resolve()
        cancelFeedback()
        dropStatus = null
        activeAction = null
        stopEvents?.()
        stopEvents = undefined
        stopContext?.()
        stopContext = undefined
        publish()
      }
    },
    setActiveAction(action: DropAction) {
      if (activeAction === action) return
      activeAction = action
      publish()
    },
    dismiss() {
      if (!listeners.size) return
      generation += 1
      captureSequence += 1
      pendingDrop = Promise.resolve()
      const owner = generation
      const expectedPresentationId = presentationId
      cancelFeedback()
      dropStatus = null
      activeAction = null
      publish()
      void readContext()
        .then(current => {
          if (!listeners.size || owner !== generation) return
          context.update(() => current)
          if (
            current.presentationId !== null &&
            (expectedPresentationId === null || current.presentationId === expectedPresentationId)
          )
            return dismissHost(current.presentationId)
        })
        .catch(error => {
          console.error('[Wework] Failed to read system drag context:', error)
        })
    },
    drop(action: DropAction, text: string, paths: string[], timestamp: number) {
      if (!listeners.size) return
      activeAction = action
      publish()
      if (!text && !paths.length) return
      const owner = captureSequence
      const expectedPresentationId = presentationId
      pendingDrop = pendingDrop.then(() =>
        captureDrop(action, text, paths, timestamp, owner, expectedPresentationId)
      )
    },
  }
}
