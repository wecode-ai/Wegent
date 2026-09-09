import type { CloudLoopItem } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'

interface Props {
  item: CloudLoopItem
}

export function IssueAssignmentPanel({ item }: Props) {
  const { t } = useTranslation()
  const workflow = item.workflow
  if (!workflow) return null
  const assignment = workflow.assignment
  if (assignment?.status === 'waiting_human') return null
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
      {!completed && assignment?.status === 'completed' && assignment.result ? (
        <div data-testid="issue-assignment-submitted-result">
          <p className="text-text-muted">{t('todo.assignment_result')}</p>
          <p className="whitespace-pre-wrap">{assignment.result}</p>
        </div>
      ) : null}
      {completed ? <p data-testid="issue-assignment-completion">{completionText}</p> : null}
    </section>
  )
}
