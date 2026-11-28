import { useState } from 'react'
import { SelectField } from '../controls/SelectField'
import { Textarea } from '../controls/Textarea'
import { Button } from '../markdown/Button'
import type { CollaborationTranslate } from '../i18n'
import type { CoordinationAssignment, SharedWorkspaceIssuesApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationIssue, IssueCoordination } from '../types'

type Decision = Parameters<NonNullable<SharedWorkspaceIssuesApi['decideRound']>>[1]['targetStatus']

function assignment(member: IssueCoordination['members'][number]): CoordinationAssignment {
  return {
    assignmentId: crypto.randomUUID(),
    assigneeType: member.kind,
    assigneeId: member.id,
    title: '',
    instructions: '',
  }
}

export function IssueCoordinationActions({
  issue,
  round,
  submitRound,
  decideRound,
  refresh,
  t,
}: {
  issue: CollaborationIssue
  round: IssueCoordination
  submitRound: NonNullable<SharedWorkspaceIssuesApi['submitRound']>
  decideRound: NonNullable<SharedWorkspaceIssuesApi['decideRound']>
  refresh(): Promise<void>
  t: CollaborationTranslate
}) {
  const members = round.members.filter(
    member => member.kind !== round.leader.kind || member.id !== round.leader.id
  )
  const [items, setItems] = useState<CoordinationAssignment[]>(() =>
    members.length ? [assignment(members[0])] : []
  )
  const [decision, setDecision] = useState<Decision>('in_review')
  const [reason, setReason] = useState('')
  const [mode, setMode] = useState<'dispatch' | 'decision'>('dispatch')
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState('')
  const memberOptions = members.map(member => ({
    value: JSON.stringify([member.kind, member.id]),
    label: member.name || member.id,
  }))

  function update(id: string, values: Partial<CoordinationAssignment>) {
    setItems(current =>
      current.map(item => (item.assignmentId === id ? { ...item, ...values } : item))
    )
  }

  async function submit() {
    if (busy) return
    setBusy(true)
    setError('')
    const context = {
      loopItemId: issue.id,
      dispatchId: round.dispatchId,
      roundId: round.roundId,
    }
    try {
      if (!accepted && !round.waitingForMembers) {
        if (mode === 'dispatch') {
          await submitRound(String(issue.cloud_project_id), {
            ...context,
            items,
          })
        } else {
          await decideRound(String(issue.cloud_project_id), {
            ...context,
            targetStatus: decision,
            reason: reason.trim(),
            idempotencyKey: JSON.stringify([round.dispatchId, round.roundId]),
          })
        }
        setAccepted(true)
      }
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="grid gap-3 py-3" aria-label={t('todo.coordinate_round')}>
      <h3 className="font-semibold">{t('todo.coordinate_round')}</h3>
      {round.waitingForMembers ? (
        <div role="status" className="space-y-1">
          <p>{t('todo.round_waiting')}</p>
          <ul>
            {round.assignments?.map(row => (
              <li key={row.assignmentId}>
                {members.find(
                  member => member.kind === row.assigneeType && member.id === row.assigneeId
                )?.name || row.assigneeId}
                {' · '}
                {t('todo.status_' + row.status, row.status)}
              </li>
            ))}
          </ul>
        </div>
      ) : accepted ? (
        <p role="status">{t('todo.round_recorded')}</p>
      ) : (
        <fieldset className="grid gap-3" disabled={busy}>
          <SelectField<'dispatch' | 'decision'>
            testId="issue-coordination-action"
            value={mode}
            accessibleLabel={t('todo.coordinate_round')}
            onChange={setMode}
            options={[
              { value: 'dispatch', label: t('todo.delegate_round') },
              { value: 'decision', label: t('todo.decide_round') },
            ]}
          />
          {mode === 'dispatch' ? (
            <>
              {!members.length && <p role="status">{t('todo.round_no_members')}</p>}
              {items.map(item => {
                const id = item.assignmentId
                const stages = round.stages.filter(
                  stage =>
                    !stage.assignee ||
                    (stage.assignee.kind === item.assigneeType &&
                      stage.assignee.id === item.assigneeId)
                )
                return (
                  <fieldset key={id} className="grid gap-2 border-l border-border pl-3">
                    <SelectField
                      testId={`issue-dispatch-member-${id}`}
                      accessibleLabel={t('todo.assignee', '负责人')}
                      options={memberOptions}
                      value={JSON.stringify([item.assigneeType, item.assigneeId])}
                      onChange={value => {
                        const member =
                          members[memberOptions.findIndex(option => option.value === value)]
                        if (member)
                          update(id, {
                            assigneeId: member.id,
                            assigneeType: member.kind,
                            workflowStageId: undefined,
                          })
                      }}
                    />
                    {stages.length > 0 && (
                      <SelectField
                        testId={`issue-dispatch-stage-${id}`}
                        accessibleLabel={t('todo.workflow_stage')}
                        value={item.workflowStageId || ' '}
                        options={[
                          { value: ' ', label: t('todo.no_workflow_stage') },
                          ...stages.map(stage => ({
                            value: stage.id,
                            label: stage.name,
                          })),
                        ]}
                        onChange={value =>
                          update(id, {
                            workflowStageId: value.trim() || undefined,
                          })
                        }
                      />
                    )}
                    <label>
                      {t('todo.assignment_instructions')}
                      <Textarea
                        data-testid={`issue-dispatch-instructions-${id}`}
                        value={item.instructions}
                        onChange={event => {
                          const instructions = event.target.value
                          update(id, {
                            instructions,
                            title: instructions.trim().split('\n')[0].slice(0, 500),
                          })
                        }}
                      />
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`issue-dispatch-remove-${id}`}
                      onClick={() => setItems(items.filter(row => row !== item))}
                    >
                      {t('todo.remove_assignment')}
                    </Button>
                  </fieldset>
                )
              })}
              <Button
                variant="outline"
                size="sm"
                disabled={!members.length || items.length >= 20}
                data-testid="issue-dispatch-add"
                onClick={() => setItems([...items, assignment(members[0])])}
              >
                {t('todo.add_assignment')}
              </Button>
            </>
          ) : (
            <>
              <SelectField<Decision>
                testId="issue-decision-status"
                accessibleLabel={t('todo.issue_status')}
                value={decision}
                onChange={setDecision}
                options={(
                  ['inbox', 'pending', 'in_progress', 'in_review', 'completed'] as const
                ).map(value => ({
                  value,
                  label: t('todo.status_' + value, value),
                }))}
              />
              <label>
                {t('todo.decision_reason')}
                <Textarea
                  data-testid="issue-decision-reason"
                  value={reason}
                  onChange={event => setReason(event.target.value)}
                />
              </label>
            </>
          )}
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {(round.waitingForMembers || !accepted || error) && (
        <Button
          size="sm"
          data-testid="issue-coordination-submit"
          disabled={
            busy ||
            (!accepted &&
              !round.waitingForMembers &&
              (mode === 'dispatch'
                ? !items.length || items.some(item => !item.title)
                : !reason.trim()))
          }
          onClick={() => void submit()}
        >
          {accepted || round.waitingForMembers
            ? t('todo.refresh_round')
            : mode === 'dispatch'
              ? t('todo.delegate_round')
              : t('todo.decide_round')}
        </Button>
      )}
    </section>
  )
}
