import { useCallback, useSyncExternalStore } from 'react'
import type { TaskReplyCard } from '@wegent/collaboration/execution/taskCardReply'

interface IssueCommentDraft {
  text: string
  replyTarget: TaskReplyCard | null
}

const empty: IssueCommentDraft = { text: '', replyTarget: null }
const drafts = new Map<string, IssueCommentDraft>()
const listeners = new Map<string, Set<() => void>>()

export function clearIssueCommentDraftsForTests() {
  drafts.clear()
  listeners.forEach(scoped => scoped.forEach(listener => listener()))
}

function update(scope: string, patch: Partial<IssueCommentDraft>) {
  const current = drafts.get(scope) ?? empty
  const next = { ...current, ...patch }
  if (current.text === next.text && current.replyTarget === next.replyTarget) return
  if (next.text || next.replyTarget) drafts.set(scope, next)
  else drafts.delete(scope)
  listeners.get(scope)?.forEach(listener => listener())
}

/** Retain unfinished discussions across route unmounts for this app session. */
export function useIssueCommentDraft(scope: string) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const scoped = listeners.get(scope) ?? new Set<() => void>()
      scoped.add(listener)
      listeners.set(scope, scoped)
      return () => {
        scoped.delete(listener)
        if (!scoped.size) listeners.delete(scope)
      }
    },
    [scope]
  )
  const snapshot = useCallback(() => drafts.get(scope) ?? empty, [scope])
  const draft = useSyncExternalStore(subscribe, snapshot, snapshot)
  const setText = useCallback((text: string) => update(scope, { text }), [scope])
  const setReplyTarget = useCallback(
    (replyTarget: TaskReplyCard | null) => update(scope, { replyTarget }),
    [scope]
  )
  return { ...draft, setText, setReplyTarget }
}
