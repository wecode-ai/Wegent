import {
  BrowserTaskDraftContext,
  createDraftOperations,
  emptyDraft,
  type TaskDraft,
} from './browserTaskDraftContext'
import { TaskReplyQueueStore } from '../execution/taskReplyQueue'
import type { RuntimeConversationQueue } from '../execution/runtimeConversationQueue'
import { useContext, useState, type ReactNode } from 'react'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import { useComposerAttachments } from '../composer/useComposerAttachments'

/** Keep each task's unsent input when its drawer closes or another task opens. */
export function BrowserTaskDrafts({
  runtime,
  children,
}: {
  runtime?: SharedWorkspaceRuntimeApi
  children: ReactNode
}) {
  const existing = useContext(BrowserTaskDraftContext)
  if (!runtime || existing?.runtime === runtime) return <>{children}</>
  return <OwnedBrowserTaskDrafts runtime={runtime}>{children}</OwnedBrowserTaskDrafts>
}

function OwnedBrowserTaskDrafts({
  runtime,
  children,
}: {
  runtime: SharedWorkspaceRuntimeApi
  children: ReactNode
}) {
  const [replyQueue] = useState(() => new TaskReplyQueueStore())
  const [conversationQueues] = useState(() => new Map<string, RuntimeConversationQueue<string>>())
  const [operations] = useState(createDraftOperations)
  const [drafts, setDrafts] = useState<Record<string, TaskDraft>>({})
  const attachments = useComposerAttachments({
    uploadAttachment: runtime.uploadAttachment,
    deleteAttachment: runtime.deleteAttachment,
  })
  return (
    <BrowserTaskDraftContext.Provider
      value={{
        runtime,
        replyQueue,
        conversationQueues,
        operations,
        drafts,
        attachments,
        update: (scope, patch) =>
          setDrafts(current => ({
            ...current,
            [scope]: { ...emptyDraft, ...current[scope], ...patch },
          })),
      }}
    >
      {children}
    </BrowserTaskDraftContext.Provider>
  )
}
