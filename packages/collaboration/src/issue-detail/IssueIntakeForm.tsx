// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from 'react'
import type { IssueIntakeDefinition } from '../automation/types'
import type { CollaborationIssue, CollaborationMember, CollaborationPriority } from '../types'
import type { CollaborationTranslate } from '../i18n'
import { workflowErrorMessage } from './workflowErrorMessage'

const emptyDefinition: IssueIntakeDefinition = {
  objective: '',
  scope: '',
  non_goals: '',
  acceptance_criteria: '',
  dependencies: '',
  proposed_owner: '',
}
const fields = ['objective', 'scope', 'non_goals', 'acceptance_criteria', 'dependencies'] as const

export function IssueIntakeForm({
  issue,
  members,
  editable,
  translate,
  onSave,
  onAdmit,
}: {
  issue: CollaborationIssue
  members: CollaborationMember[]
  editable: boolean
  translate: CollaborationTranslate
  onSave(
    definition: IssueIntakeDefinition,
    priority: CollaborationPriority
  ): Promise<CollaborationIssue>
  onAdmit(version: number, key: string): Promise<void>
}) {
  const [definition, setDefinition] = useState<IssueIntakeDefinition>(
    issue.intake_definition ?? emptyDefinition
  )
  const [priority, setPriority] = useState(issue.priority)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const key = useRef(crypto.randomUUID())
  const savedDefinition = useRef<{ signature: string; version: number } | null>(null)
  const complete = Object.values(definition).every(value => value.trim()) && priority !== 'none'
  const submit = async (admit: boolean) => {
    if (busy || !editable || (admit && !complete)) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const normalized = Object.fromEntries(
        Object.entries(definition).map(([field, value]) => [field, value.trim()])
      ) as unknown as IssueIntakeDefinition
      const signature = JSON.stringify([normalized, priority])
      if (!admit || savedDefinition.current?.signature !== signature) {
        const updated = await onSave(normalized, priority)
        savedDefinition.current = { signature, version: updated.version }
      }
      if (admit) await onAdmit(savedDefinition.current!.version, key.current)
      else setSaved(true)
    } catch (cause) {
      setError(workflowErrorMessage(cause, translate))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="space-y-3 py-3 text-sm"
      data-testid="issue-intake-form"
      onSubmit={event => {
        event.preventDefault()
        void submit(true)
      }}
    >
      <p className="text-text-secondary">
        {translate(
          'todo.strategy_inbox_hint',
          '收集箱用于完善定义，不启动阶段任务或助理。补齐以下内容后再进入需求提出。'
        )}
      </p>
      {fields.map(field => (
        <label className="flex flex-col gap-1" key={field}>
          {translate(`todo.intake_${field}`, field)}
          <textarea
            disabled={!editable || busy}
            value={definition[field]}
            maxLength={10000}
            data-testid={`issue-intake-${field}`}
            className="min-h-20 rounded-md border border-border bg-background p-2 text-text-primary disabled:opacity-60"
            onChange={event => {
              setDefinition(current => ({ ...current, [field]: event.target.value }))
              setSaved(false)
            }}
          />
        </label>
      ))}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          {translate('todo.intake_proposed_owner', '拟负责人')}
          <select
            value={definition.proposed_owner}
            disabled={!editable || busy}
            data-testid="issue-intake-proposed_owner"
            className="min-h-11 rounded-md border border-border bg-background px-2 text-text-primary md:min-h-8"
            onChange={event => {
              setDefinition(current => ({ ...current, proposed_owner: event.target.value }))
              setSaved(false)
            }}
          >
            <option value="">{translate('todo.intake_choose_owner', '选择项目成员')}</option>
            {definition.proposed_owner &&
            !members.some(member => member.user_name === definition.proposed_owner) ? (
              <option value={definition.proposed_owner}>{definition.proposed_owner}</option>
            ) : null}
            {members
              .filter(member => member.can_be_assignee !== false && member.role !== 'Viewer')
              .map(member => (
                <option key={member.user_id} value={member.user_name}>
                  {member.user_name}
                </option>
              ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          {translate('todo.priority', '优先级')}
          <select
            value={priority}
            disabled={!editable || busy}
            data-testid="issue-intake-priority"
            className="min-h-11 rounded-md border border-border bg-background px-2 text-text-primary md:min-h-8"
            onChange={event => {
              setPriority(event.target.value as CollaborationPriority)
              setSaved(false)
            }}
          >
            {(['none', 'low', 'medium', 'high', 'urgent'] as const).map(value => (
              <option value={value} key={value}>
                {translate(`todo.priority_${value}`, value)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-error" data-testid="issue-intake-error">
          {error}
        </p>
      ) : null}
      {saved ? <p role="status">{translate('todo.intake_saved', '收集箱定义已保存')}</p> : null}
      {editable ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            className="task-detail-workspace-ghost-action"
            data-testid="issue-intake-save"
            onClick={() => void submit(false)}
          >
            {translate('todo.intake_save', '保存定义')}
          </button>
          <button
            type="submit"
            disabled={busy || !complete}
            className="min-h-11 rounded-md bg-text-primary px-3 text-background disabled:opacity-50 md:min-h-8"
            data-testid="issue-intake-admit"
          >
            {translate('todo.intake_admit', '保存并进入需求提出')}
          </button>
        </div>
      ) : null}
    </form>
  )
}
