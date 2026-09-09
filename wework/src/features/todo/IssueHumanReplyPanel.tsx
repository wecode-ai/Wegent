import { useEffect, useRef, useState } from 'react'
import type { CloudLoopItem, IssueWorkflowInstance } from '@/api/deliveries'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

type ReplyAction = (
  itemId: string,
  assignmentId: string,
  summary: string
) => Promise<IssueWorkflowInstance>
interface Props {
  item: CloudLoopItem
  currentUserId?: string | number
  expectedAssignmentId?: string | null
  requestedReply?: { text: string } | null
  saveReply?: ReplyAction
  submitResult?: ReplyAction
  onUpdated: () => Promise<void>
}

export function IssueHumanReplyPanel(props: Props) {
  const { t } = useTranslation()
  const assignment = props.item.workflow?.assignment
  if (props.expectedAssignmentId && props.expectedAssignmentId !== assignment?.id) {
    return (
      <p
        role="status"
        data-testid="issue-assignment-expired"
        className="my-4 rounded-lg border border-border p-4 text-sm"
      >
        {t('todo.human_reply_expired')}
      </p>
    )
  }
  if (!assignment || assignment.status !== 'waiting_human') {
    return props.expectedAssignmentId ? (
      <p role="status" data-testid="issue-assignment-handled" className="my-4 text-sm">
        {t('todo.human_reply_handled')}
      </p>
    ) : null
  }
  return (
    <HumanReplyForm key={`${props.item.id}:${assignment.id}:${props.currentUserId}`} {...props} />
  )
}

function HumanReplyForm({
  item,
  currentUserId,
  requestedReply,
  saveReply,
  submitResult,
  onUpdated,
}: Props) {
  const { t } = useTranslation()
  const assignment = item.workflow!.assignment!
  const storageKey = `issue-human-reply:${currentUserId}:${item.id}:${assignment.id}`
  const [text, setText] = useState(
    () => sessionStorage.getItem(storageKey) ?? assignment.reply_draft ?? ''
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const canReply =
    currentUserId != null && String(currentUserId) === String(assignment.assignee_user_id)
  const paused = item.workflow?.orchestration_status === 'paused'
  const [appliedRequest, setAppliedRequest] = useState<Props['requestedReply']>(null)
  if (requestedReply !== appliedRequest) {
    setAppliedRequest(requestedReply)
    if (canReply && requestedReply?.text) setText(requestedReply.text)
  }
  useEffect(() => {
    if (!requestedReply || !canReply) return
    if (requestedReply.text) {
      sessionStorage.setItem(storageKey, requestedReply.text)
    }
    textarea.current?.scrollIntoView({ block: 'center' })
    textarea.current?.focus()
  }, [requestedReply, storageKey, canReply])
  const submit = async (advance: boolean) => {
    const action = advance ? submitResult : saveReply
    if (!action || !text.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      await action(item.id, assignment.id, text.trim())
      if (advance) sessionStorage.removeItem(storageKey)
      else sessionStorage.setItem(storageKey, text.trim())
      if (!active.current) return
      setSaved(!advance)
      if (advance) setText('')
      await onUpdated()
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (active.current) setBusy(false)
    }
  }
  return (
    <section
      data-testid="issue-assignment-human-control"
      className="my-4 space-y-3 rounded-lg border border-border bg-surface p-4 text-sm"
    >
      <div>
        <p className="font-medium">
          {t(canReply ? 'todo.human_reply_yours' : 'todo.human_reply_waiting', {
            name: item.assignee_name || String(assignment.assignee_user_id),
          })}
        </p>
        <p className="mt-1 whitespace-pre-wrap">
          {item.workflow?.current_work || assignment.decision.instruction}
        </p>
      </div>
      {canReply ? (
        <form
          onSubmit={event => {
            event.preventDefault()
            void submit(false)
          }}
          className="space-y-3"
        >
          <label className="block">
            {t('todo.human_reply_label')}
            <textarea
              ref={textarea}
              data-testid="issue-assignment-result"
              value={text}
              disabled={busy}
              rows={4}
              onChange={event => {
                setText(event.target.value)
                sessionStorage.setItem(storageKey, event.target.value)
                setSaved(false)
              }}
              placeholder={t('todo.human_reply_placeholder')}
              className="mt-2 block w-full resize-y rounded-md border border-border bg-background p-3"
            />
          </label>
          <p className="text-xs text-text-muted">
            {t(paused ? 'todo.human_reply_paused' : 'todo.human_reply_help')}
          </p>
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              type="submit"
              variant="outline"
              data-testid="issue-assignment-save-reply"
              disabled={busy || !text.trim() || !saveReply}
              className="min-h-11 md:min-h-0"
            >
              {t('todo.human_reply_save')}
            </Button>
            <Button
              type="button"
              data-testid="issue-assignment-submit-result"
              onClick={() => void submit(true)}
              disabled={busy || !text.trim() || !submitResult || paused}
              className="min-h-11 md:min-h-0"
            >
              {t('todo.assignment_submit_result')}
            </Button>
          </div>
          {saved ? (
            <p role="status" className="text-text-muted">
              {t('todo.human_reply_saved')}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <p className="text-text-muted">{t('todo.human_reply_owner_only')}</p>
      )}
    </section>
  )
}
