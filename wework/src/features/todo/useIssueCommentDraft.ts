import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { TaskReplyCard } from '@wegent/collaboration/execution/taskCardReply'

interface IssueCommentDraft {
  text: string
  replyTarget: TaskReplyCard | null
  replyFocusRequest: { rootId: string; scope: string } | null
}

const empty: IssueCommentDraft = { text: '', replyTarget: null, replyFocusRequest: null }
const drafts = new Map<string, IssueCommentDraft>()
const listeners = new Map<string, Set<() => void>>()

export function clearIssueCommentDraftsForTests() {
  drafts.clear()
  listeners.forEach(scoped => scoped.forEach(listener => listener()))
}

export function updateIssueCommentDraft(scope: string, patch: Partial<IssueCommentDraft>) {
  const current = drafts.get(scope) ?? empty
  const next = { ...current, ...patch }
  if (
    current.text === next.text &&
    current.replyTarget === next.replyTarget &&
    current.replyFocusRequest === next.replyFocusRequest
  )
    return
  if (next.text || next.replyTarget) drafts.set(scope, next)
  else drafts.delete(scope)
  listeners.get(scope)?.forEach(listener => listener())
}

export const getIssueCommentDraft = (scope: string) => drafts.get(scope) ?? empty

export interface NotificationReplySelection {
  id: string
  card: TaskReplyCard
}

function createIssueCommentDraftObserver(scope: string) {
  let selectedNotification: string | null = null
  return {
    getSnapshot: () => getIssueCommentDraft(scope),
    subscribe(listener: () => void, selection?: NotificationReplySelection | null) {
      const scoped = listeners.get(scope) ?? new Set<() => void>()
      scoped.add(listener)
      listeners.set(scope, scoped)
      if (selection && selectedNotification !== selection.id) {
        selectedNotification = selection.id
        updateIssueCommentDraft(scope, { replyTarget: selection.card, replyFocusRequest: null })
      }
      return () => {
        scoped.delete(listener)
        if (!scoped.size) listeners.delete(scope)
      }
    },
  }
}

/** Retain unfinished discussions across route unmounts for this app session. */
export function useIssueCommentDraft(scope: string, selection?: NotificationReplySelection | null) {
  const source = useMemo(() => createIssueCommentDraftObserver(scope), [scope])
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe(listener, selection),
    [source, selection]
  )
  const draft = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  const setText = useCallback((text: string) => updateIssueCommentDraft(scope, { text }), [scope])
  const setReplyTarget = useCallback(
    (replyTarget: TaskReplyCard | null) =>
      updateIssueCommentDraft(scope, {
        replyTarget,
        replyFocusRequest: replyTarget ? { rootId: replyTarget.root.messageId, scope } : null,
      }),
    [scope]
  )
  const beginReply = useCallback(
    (replyTarget: TaskReplyCard) =>
      updateIssueCommentDraft(scope, {
        replyTarget,
        replyFocusRequest: { rootId: replyTarget.root.messageId, scope },
      }),
    [scope]
  )
  return { ...draft, setText, setReplyTarget, beginReply }
}
