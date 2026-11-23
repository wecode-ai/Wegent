import type { ProjectChatMention } from '@wegent/chat-core'
import type { CollaborationComment } from '../types'

interface CommentDraftSnapshot {
  draft: string
  sending: boolean
  failure: { cause: unknown } | null
}
interface CommentSubmission {
  body: string
  mentions: ProjectChatMention[] | undefined
  send(body: string, mentions?: ProjectChatMention[]): Promise<CollaborationComment | void>
  onSent(comment: CollaborationComment): void
  onError(): void
  resetAttachments(): void
}

/** One Issue owner controls the draft and every receipt from its sends. */
export function createWebCommentDraft() {
  let snapshot: CommentDraftSnapshot = { draft: '', sending: false, failure: null }
  const listeners = new Set<() => void>()
  let revision = 0
  const publish = (next: CommentDraftSnapshot) => {
    snapshot = next
    listeners.forEach(listener => listener())
  }
  const active = (request: number) => revision === request && listeners.size > 0
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        revision++
        snapshot = { ...snapshot, sending: false }
      }
    },
    setDraft(draft: string) {
      publish({ ...snapshot, draft })
    },
    async submit(command: CommentSubmission): Promise<boolean> {
      if (snapshot.sending || !listeners.size) return false
      const request = ++revision
      publish({ ...snapshot, sending: true, failure: null })
      try {
        const comment = await command.send(
          command.body,
          ...(command.mentions === undefined ? [] : [command.mentions])
        )
        if (!active(request)) return false
        if (comment) command.onSent(comment)
        if (!active(request)) return false
        publish({ ...snapshot, draft: '' })
        command.resetAttachments()
        return true
      } catch (cause) {
        if (!active(request)) return false
        publish({ ...snapshot, failure: { cause } })
        command.onError()
        return false
      } finally {
        if (active(request)) publish({ ...snapshot, sending: false })
      }
    },
  }
}
