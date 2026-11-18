// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import type { WorkflowDeliverableRequirement, WorkflowNodeInstance } from '../automation/types'
import type { CollaborationTranslate } from '../i18n'
import { workflowErrorMessage } from './workflowErrorMessage'

export interface WorkflowEvidenceFile {
  requirementId: string
  kind: 'file' | 'code_snapshot'
  file: File
}

interface EvidenceValue {
  kind: WorkflowDeliverableRequirement['value_type']
  fields: Record<string, string>
  files: File[]
}

function hasEvidenceInput(value: EvidenceValue): boolean {
  if (value.kind === 'file' || value.kind === 'code_snapshot') return value.files.length > 0
  return Object.entries(value.fields).some(
    ([name, input]) => name !== 'provider' && name !== 'state' && input.trim()
  )
}

const inputClass =
  'min-h-11 rounded-md border border-border bg-background px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/70 disabled:opacity-50 md:min-h-8'

export function WorkflowDeliverablesForm({
  node,
  translate,
  onSubmit,
  onCancel,
}: {
  node: WorkflowNodeInstance
  translate: CollaborationTranslate
  onSubmit(
    fulfillments: Array<Record<string, unknown>>,
    files: WorkflowEvidenceFile[]
  ): Promise<void>
  onCancel?(): void
}) {
  const requirements = node.required_deliverables ?? []
  const [values, setValues] = useState<Record<string, EvidenceValue>>(() =>
    Object.fromEntries(
      requirements.map(requirement => [
        requirement.id,
        {
          kind: requirement.value_type,
          fields: { provider: 'github', state: requirement.pull_request_state ?? 'open' },
          files: [],
        },
      ])
    )
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const change = (id: string, field: string, value: string) =>
    setValues(current => ({
      ...current,
      [id]: { ...current[id], fields: { ...current[id].fields, [field]: value } },
    }))
  return (
    <form
      className="space-y-4 rounded-md bg-muted/40 p-3"
      data-testid="workflow-deliverables-form"
      onSubmit={async event => {
        event.preventDefault()
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          const fulfillments: Array<Record<string, unknown>> = []
          const files: WorkflowEvidenceFile[] = []
          for (const requirement of requirements) {
            const value = values[requirement.id]
            if (!hasEvidenceInput(value)) continue
            if (value.kind === 'file' || value.kind === 'code_snapshot') {
              const minimum =
                value.kind === 'file' ? (requirement.file_constraints?.min_files ?? 1) : 1
              const maximum =
                value.kind === 'file' ? (requirement.file_constraints?.max_files ?? 1) : 1
              if (value.files.length < minimum || value.files.length > maximum)
                throw new Error(
                  translate('todo.workflow_file_count', '{{name}} 需要 {{min}}–{{max}} 个文件', {
                    name: requirement.name,
                    min: minimum,
                    max: maximum,
                  })
                )
              files.push(
                ...value.files.map(file => ({
                  requirementId: requirement.id,
                  kind: value.kind as 'file' | 'code_snapshot',
                  file,
                }))
              )
            } else {
              const fields = Object.fromEntries(
                Object.entries(value.fields).map(([key, entry]) => [key, entry.trim()])
              )
              fulfillments.push({
                requirement_id: requirement.id,
                kind: value.kind,
                ...(value.kind === 'text'
                  ? { text: fields.text }
                  : value.kind === 'url'
                    ? { url: fields.url, title: requirement.name }
                    : value.kind === 'pull_request'
                      ? {
                          provider: fields.provider,
                          url: fields.url,
                          number: Number(fields.number),
                          state: requirement.pull_request_state ?? fields.state,
                          head_branch: fields.head_branch,
                          base_branch: fields.base_branch,
                          head_commit: fields.head_commit,
                        }
                      : {
                          remote_url: fields.remote_url,
                          branch: fields.branch,
                          commit_sha: fields.commit_sha,
                        }),
              })
            }
          }
          if (!fulfillments.length && !files.length)
            throw new Error(translate('todo.workflow_evidence_empty', '请至少填写或选择一项证据'))
          await onSubmit(fulfillments, files)
        } catch (cause) {
          setError(workflowErrorMessage(cause, translate))
        } finally {
          setBusy(false)
        }
      }}
    >
      <h4 className="font-medium text-text-primary">
        {translate('todo.workflow_submit_stage_evidence', '提交阶段交付物')} · {node.name}
      </h4>
      <p className="text-sm text-text-secondary">
        {translate(
          'todo.workflow_evidence_partial',
          '可分次提交自己负责的证据；阶段推进仍需全部必填证据齐备。'
        )}
      </p>
      {requirements.map(requirement => {
        const value = values[requirement.id]
        const kinds = [
          ...new Set([requirement.value_type, ...(requirement.accepted_value_types ?? [])]),
        ]
        const field = (name: string, label: string, type = 'text', maxLength = 2000) => (
          <label className="flex flex-col gap-1" key={name}>
            {translate(`todo.workflow_evidence_${name}`, label)}
            <input
              required={hasEvidenceInput(value)}
              disabled={busy}
              type={type}
              min={type === 'number' ? 1 : undefined}
              maxLength={maxLength}
              className={inputClass}
              data-testid={`workflow-deliverable-${requirement.id}-${name}`}
              value={value.fields[name] ?? ''}
              onChange={event => change(requirement.id, name, event.target.value)}
            />
          </label>
        )
        return (
          <fieldset key={requirement.id} disabled={busy} className="space-y-2">
            <legend className="mb-2 font-medium text-text-primary">{requirement.name}</legend>
            {kinds.length > 1 ? (
              <select
                aria-label={requirement.name}
                value={value.kind}
                className={inputClass}
                data-testid={`workflow-deliverable-${requirement.id}-kind`}
                onChange={event =>
                  setValues(current => ({
                    ...current,
                    [requirement.id]: {
                      ...current[requirement.id],
                      kind: event.target.value as EvidenceValue['kind'],
                    },
                  }))
                }
              >
                {kinds.map(kind => (
                  <option key={kind} value={kind}>
                    {translate(`todo.workflow_kind_${kind}`, kind)}
                  </option>
                ))}
              </select>
            ) : null}
            {value.kind === 'file' || value.kind === 'code_snapshot' ? (
              <input
                type="file"
                className={inputClass}
                aria-label={requirement.name}
                data-testid={`workflow-deliverable-${requirement.id}-file`}
                multiple={
                  value.kind === 'file' && (requirement.file_constraints?.max_files ?? 1) > 1
                }
                accept={
                  value.kind === 'file'
                    ? requirement.file_constraints?.accepted_types.join(',')
                    : undefined
                }
                onChange={event => {
                  const files = Array.from(event.target.files ?? [])
                  setValues(current => ({
                    ...current,
                    [requirement.id]: { ...current[requirement.id], files },
                  }))
                }}
              />
            ) : null}
            {value.kind === 'text' ? (
              <textarea
                disabled={busy}
                maxLength={100000}
                className="min-h-24 w-full rounded-md border border-border bg-background p-2 text-text-primary"
                aria-label={requirement.name}
                data-testid={`workflow-deliverable-${requirement.id}-text`}
                value={value.fields.text ?? ''}
                onChange={event => change(requirement.id, 'text', event.target.value)}
              />
            ) : null}
            {value.kind === 'url' ? field('url', '链接', 'url') : null}
            {value.kind === 'pull_request' ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  {translate('todo.workflow_evidence_provider', '代码托管服务')}
                  <select
                    className={inputClass}
                    value={value.fields.provider}
                    data-testid={`workflow-deliverable-${requirement.id}-provider`}
                    onChange={event => change(requirement.id, 'provider', event.target.value)}
                  >
                    <option value="github">GitHub</option>
                    <option value="gitlab">GitLab</option>
                  </select>
                </label>
                {field('url', 'PR / MR 链接', 'url')}
                {field('number', 'PR / MR 编号', 'number')}
                <label className="flex flex-col gap-1">
                  {translate('todo.workflow_evidence_state', '状态')}
                  <select
                    disabled={busy || requirement.pull_request_state === 'merged'}
                    className={inputClass}
                    value={requirement.pull_request_state ?? value.fields.state}
                    data-testid={`workflow-deliverable-${requirement.id}-state`}
                    onChange={event => change(requirement.id, 'state', event.target.value)}
                  >
                    <option value="draft">{translate('todo.workflow_pr_draft', '草稿')}</option>
                    <option value="open">{translate('todo.workflow_pr_open', '待合并')}</option>
                    <option value="merged">{translate('todo.workflow_pr_merged', '已合并')}</option>
                  </select>
                </label>
                {field('head_branch', '来源分支', 'text', 255)}
                {field('base_branch', '目标分支', 'text', 255)}
                {field('head_commit', '提交 SHA', 'text', 64)}
              </div>
            ) : null}
            {value.kind === 'git_branch' ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {field('remote_url', 'Git 远程仓库')}
                {field('branch', '分支', 'text', 255)}
                {field('commit_sha', '提交 SHA', 'text', 64)}
              </div>
            ) : null}
          </fieldset>
        )
      })}
      {error ? (
        <p role="alert" className="text-error" data-testid="workflow-deliverables-error">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 rounded-md bg-text-primary px-3 text-background disabled:opacity-50 md:min-h-8"
          data-testid="workflow-deliverables-submit"
        >
          {busy
            ? translate('todo.workflow_submitting_evidence', '提交中…')
            : translate('todo.workflow_submit_evidence', '提交交付物')}
        </button>
        {onCancel ? (
          <button
            type="button"
            disabled={busy}
            className="task-detail-workspace-ghost-action"
            onClick={onCancel}
            data-testid="workflow-deliverables-cancel"
          >
            {translate('cancel', '取消')}
          </button>
        ) : null}
      </div>
    </form>
  )
}
