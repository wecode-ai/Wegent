import { useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { CornerDownRight } from 'lucide-react'
import type { CollaborationIssue } from '../types'
import type { CollaborationTranslate } from '../i18n'
import type { CommentAssignment } from './useCommentAssignment'
import { IssueDetailSearchableSelect } from './IssueDetailControls'

/** Any visible comment can seed a child; mentions never confer authority. */
export function IssueCommentChildAction({
  body,
  messageId,
  assignment,
  onComment,
  translate: t,
}: {
  body: string
  messageId: string
  assignment: CommentAssignment
  onComment(text: string, requestId: string): Promise<void>
  translate: CollaborationTranslate
}) {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState(false)
  const [error, setError] = useState('')
  const progress = useRef<{
    requestId: string
    child?: CollaborationIssue
  } | null>(null)
  const submit = async () => {
    if (busy || !assignment.createChild) return
    setBusy(true)
    setError('')
    const operation = progress.current ?? { requestId: crypto.randomUUID() }
    progress.current = operation
    try {
      operation.child ??= await assignment.createChild({
        body,
        target,
        sourceMessageId: messageId,
        requestId: operation.requestId,
      })
      setCreated(true)
      const child = operation.child
      const reference = `[$#${child.sequence_number} ${child.title.replaceAll('[', '').replaceAll(']', '')}](wework-issue://${encodeURIComponent(child.cloud_project_id)}/${encodeURIComponent(child.id)})`
      await onComment(
        t('todo.child_created_from_comment', undefined, { title: reference }),
        operation.requestId
      )
      progress.current = null
      setCreated(false)
      setOpen(false)
      setTarget('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  if (!assignment.createChild || !body.trim()) return null
  return (
    <Popover.Root
      open={open}
      onOpenChange={next => {
        if (!busy) setOpen(next)
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid={`issue-comment-create-child-${messageId}`}
          className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs text-text-muted hover:bg-muted hover:text-text-primary md:min-h-7"
        >
          <CornerDownRight className="h-3.5 w-3.5" />
          {t('todo.create_child_issue')}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          collisionPadding={12}
          className="z-modal w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-3 text-text-primary shadow-lg"
          data-testid={`issue-comment-child-form-${messageId}`}
        >
          <p className="mb-2 text-sm font-medium">{t('todo.create_child_issue')}</p>
          <p className="mb-3 line-clamp-3 whitespace-pre-wrap text-sm text-text-secondary">
            {body}
          </p>
          <IssueDetailSearchableSelect
            testId={`issue-comment-child-assignee-${messageId}`}
            accessibleLabel={t('todo.comment_assign_to')}
            value={target}
            onChange={setTarget}
            disabled={busy || created}
            searchPlaceholder={t('todo.search_assignee')}
            emptyLabel={t('todo.no_matching_assignee')}
            triggerContent={
              assignment.options.find(option => option.value === target)?.label ??
              t('todo.unassigned')
            }
            options={[{ value: '', label: t('todo.unassigned') }, ...assignment.options]}
          />
          {error && (
            <p role="alert" className="mt-2 text-sm text-error">
              {error}
            </p>
          )}
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              disabled={busy}
              data-testid={`issue-comment-child-confirm-${messageId}`}
              onClick={() => void submit()}
              className="min-h-11 rounded-md bg-text-primary px-3 text-sm text-background disabled:opacity-50 md:min-h-8"
            >
              {t(busy ? 'todo.saving' : 'todo.create_child_issue')}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
