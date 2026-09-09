import { useEffect, useRef, useState } from 'react'
import type { CloudLoopItem, IssueWorkflowInstance } from '@/api/deliveries'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

interface Props {
  item: CloudLoopItem
  currentUserId?: string | number
  submitResult?: (
    itemId: string,
    assignmentId: string,
    summary: string
  ) => Promise<IssueWorkflowInstance>
  onUpdated: () => Promise<void>
}

function AssignmentResultForm({
  itemId,
  assignmentId,
  submitResult,
  onUpdated,
  paused,
}: {
  itemId: string
  assignmentId: string
  submitResult: NonNullable<Props['submitResult']>
  onUpdated: Props['onUpdated']
  paused: boolean
}) {
  const { t } = useTranslation()
  const [summary, setSummary] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const submit = async () => {
    if (!summary.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      await submitResult(itemId, assignmentId, summary.trim())
      if (!active.current) return
      await onUpdated()
      setSummary('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      onSubmit={event => {
        event.preventDefault()
        void submit()
      }}
      className="space-y-2"
    >
      <label className="block">
        {t('todo.assignment_result')}
        <textarea
          data-testid="issue-assignment-result"
          value={summary}
          onChange={event => setSummary(event.target.value)}
          disabled={busy}
          className="mt-1 block min-h-20 w-full rounded-lg border border-border bg-background p-2"
        />
      </label>
      <Button
        type="submit"
        data-testid="issue-assignment-submit-result"
        disabled={busy || !summary.trim()}
        size="sm"
        className="min-h-11 min-w-11 md:min-h-0"
      >
        {t(paused ? 'todo.assignment_save_result' : 'todo.assignment_submit_result')}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  )
}

export function IssueAssignmentPanel({ item, currentUserId, submitResult, onUpdated }: Props) {
  const { t } = useTranslation()
  const workflow = item.workflow
  if (!workflow) return null
  const assignment = workflow.assignment
  const completed = workflow.orchestration_status === 'completed'
  const unassignedText = t(
    workflow.orchestration_status === 'planning' || workflow.orchestration_status === 'dispatching'
      ? 'todo.assignment_planning'
      : 'todo.assignment_no_active_work'
  )
  const completionText = t(
    item.status === 'completed' ? 'todo.assignment_completed' : 'todo.assignment_awaiting_review'
  )
  const role = workflow.nodes.find(node => node.id === workflow.current_stage_id)
  const canSubmit =
    assignment?.status === 'waiting_human' &&
    currentUserId != null &&
    assignment.assignee_user_id != null &&
    String(assignment.assignee_user_id) === String(currentUserId)
  return (
    <section className="mt-4 space-y-3 text-sm" data-testid="issue-assignment-panel">
      <div>
        <p className="text-text-muted">{t('todo.assignment_intent')}</p>
        <p className="whitespace-pre-wrap">{workflow.intent || item.description || item.title}</p>
      </div>
      {workflow.initial_stage_id ? (
        <div>
          <p className="text-text-muted">{t('todo.assignment_initial_role')}</p>
          <p>{workflow.nodes.find(node => node.id === workflow.initial_stage_id)?.name}</p>
        </div>
      ) : null}
      <div>
        <p className="text-text-muted">{t('todo.assignment_current_role')}</p>
        <p data-testid="issue-assignment-current-role">
          {completed
            ? t('todo.assignment_no_active_work')
            : (role?.name ?? (assignment ? t('todo.assignment_outside_graph') : unassignedText))}
        </p>
      </div>
      <div>
        <p className="text-text-muted">
          {t(completed ? 'todo.assignment_result' : 'todo.assignment_current_work')}
        </p>
        <p className="whitespace-pre-wrap">
          {completed
            ? assignment?.result || assignment?.decision?.reason || completionText
            : workflow.current_work || unassignedText}
        </p>
      </div>
      {workflow.orchestration_status === 'waiting_human' ? (
        <div data-testid="issue-assignment-human-control" className="space-y-1">
          <p>{t('todo.assignment_waiting_human')}</p>
          <p className="text-text-muted">{t('todo.assignment_human_control_help')}</p>
        </div>
      ) : null}
      {!completed && assignment?.status === 'completed' && assignment.result ? (
        <div data-testid="issue-assignment-submitted-result">
          <p className="text-text-muted">{t('todo.assignment_result')}</p>
          <p className="whitespace-pre-wrap">{assignment.result}</p>
        </div>
      ) : null}
      {completed ? <p data-testid="issue-assignment-completion">{completionText}</p> : null}
      {canSubmit && assignment && submitResult ? (
        <AssignmentResultForm
          key={`${item.id}:${assignment.id}:${currentUserId}`}
          itemId={item.id}
          assignmentId={assignment.id}
          submitResult={submitResult}
          onUpdated={onUpdated}
          paused={workflow.orchestration_status === 'paused'}
        />
      ) : null}
    </section>
  )
}
