import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { DeliverableRequirement, DeliverableValueType } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'

export interface WorkflowDeliverableDraft {
  requirement: DeliverableRequirement
  text?: string
  files?: File[]
  url?: string
  title?: string
  remoteUrl?: string
  branch?: string
  commitSha?: string
  provider?: 'github' | 'gitlab'
  number?: string
  headBranch?: string
  baseBranch?: string
}

interface WorkflowStageCompletionDialogProps {
  stageName: string
  requirements: DeliverableRequirement[]
  action: 'submit' | 'approve' | 'force_advance'
  busy: boolean
  reason: string
  values: Record<string, WorkflowDeliverableDraft>
  onReasonChange: (reason: string) => void
  onValuesChange: (values: Record<string, WorkflowDeliverableDraft>) => void
  onClose: () => void
  onSubmit: () => void
}

function isComplete(value: WorkflowDeliverableDraft | undefined): boolean {
  if (!value) return false
  const type = value.requirement.value_type
  if (type === 'text') return Boolean(value.text?.trim())
  if (type === 'file' || type === 'code_snapshot') return Boolean(value.files?.length)
  if (type === 'url') return Boolean(value.url?.trim())
  if (type === 'git_branch') {
    return Boolean(value.remoteUrl?.trim() && value.branch?.trim() && value.commitSha?.trim())
  }
  return Boolean(
    value.url?.trim() &&
    value.number?.trim() &&
    value.headBranch?.trim() &&
    value.baseBranch?.trim() &&
    value.commitSha?.trim()
  )
}

function typeLabel(
  type: DeliverableValueType,
  t: (key: string, fallback: string) => string
): string {
  if (type === 'text') return t('todo.deliverable_type_text', '文本')
  if (type === 'file') return t('todo.deliverable_type_file', '文件')
  if (type === 'code_snapshot') return t('todo.deliverable_type_code_snapshot', '代码快照')
  if (type === 'git_branch') return t('todo.deliverable_type_git_branch', 'Git 分支')
  if (type === 'pull_request') return t('todo.deliverable_type_pull_request', 'PR/MR')
  return t('todo.deliverable_type_url', '链接')
}

export function WorkflowStageCompletionDialog({
  stageName,
  requirements,
  action,
  busy,
  reason,
  values,
  onReasonChange,
  onValuesChange,
  onClose,
  onSubmit,
}: WorkflowStageCompletionDialogProps) {
  const { t } = useTranslation('common')
  const canSubmit =
    !busy &&
    (action !== 'approve' ||
      requirements.every(requirement => isComplete(values[requirement.id]))) &&
    (action !== 'force_advance' || Boolean(reason.trim()))

  const updateValue = (
    requirement: DeliverableRequirement,
    patch: Partial<WorkflowDeliverableDraft>
  ) =>
    onValuesChange({
      ...values,
      [requirement.id]: {
        ...(values[requirement.id] ?? { requirement }),
        requirement,
        ...patch,
      },
    })

  return createPortal(
    <div
      className="fixed inset-0 z-system flex items-center justify-center bg-black/35 p-6 backdrop-blur-sm"
      onMouseDown={event => event.currentTarget === event.target && !busy && onClose()}
    >
      <section
        data-testid="workflow-stage-completion-dialog"
        className="flex max-h-[calc(100vh-72px)] w-[560px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-2xl bg-background shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-text-primary">
              {action === 'submit'
                ? t('todo.workflow_submit_deliverables', '补充交付物')
                : action === 'approve'
                  ? t('todo.workflow_complete_stage', '完成并继续')
                  : t('todo.workflow_force_advance', '强制继续')}
            </h2>
            <p className="mt-0.5 truncate text-xs text-text-muted">{stageName}</p>
          </div>
          <button
            type="button"
            data-testid="workflow-stage-completion-close"
            disabled={busy}
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-muted disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {requirements.map(requirement => {
            const value = values[requirement.id] ?? { requirement }
            return (
              <fieldset
                key={requirement.id}
                data-testid={`workflow-deliverable-input-${requirement.id}`}
                className="rounded-xl border border-border p-3"
              >
                <legend className="px-1 text-sm font-medium text-text-primary">
                  {requirement.name}
                  <span className="ml-2 text-xs font-normal text-text-muted">
                    {typeLabel(requirement.value_type, t)}
                  </span>
                </legend>
                {requirement.description ? (
                  <p className="mb-2 text-xs text-text-muted">{requirement.description}</p>
                ) : null}
                {requirement.value_type === 'text' ? (
                  <textarea
                    value={value.text ?? ''}
                    onChange={event => updateValue(requirement, { text: event.target.value })}
                    className="min-h-24 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-blue-500"
                  />
                ) : requirement.value_type === 'file' ||
                  requirement.value_type === 'code_snapshot' ? (
                  <input
                    type="file"
                    multiple={requirement.value_type === 'file'}
                    data-testid={`workflow-deliverable-file-${requirement.id}`}
                    onChange={event =>
                      updateValue(requirement, { files: Array.from(event.target.files ?? []) })
                    }
                    className="block w-full text-xs text-text-secondary file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-2 file:text-xs file:text-text-primary"
                  />
                ) : requirement.value_type === 'url' ? (
                  <div className="space-y-2">
                    <input
                      value={value.url ?? ''}
                      onChange={event => updateValue(requirement, { url: event.target.value })}
                      placeholder="https://"
                      className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-blue-500"
                    />
                    <input
                      value={value.title ?? ''}
                      onChange={event => updateValue(requirement, { title: event.target.value })}
                      placeholder={t('todo.workflow_deliverable_link_title', '链接标题（可选）')}
                      className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-blue-500"
                    />
                  </div>
                ) : requirement.value_type === 'git_branch' ? (
                  <div className="grid gap-2">
                    <input
                      value={value.remoteUrl ?? ''}
                      onChange={event =>
                        updateValue(requirement, { remoteUrl: event.target.value })
                      }
                      placeholder={t('todo.workflow_git_remote', '远程仓库地址')}
                      className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-blue-500"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={value.branch ?? ''}
                        onChange={event => updateValue(requirement, { branch: event.target.value })}
                        placeholder={t('todo.workflow_git_branch', '分支名')}
                        className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-blue-500"
                      />
                      <input
                        value={value.commitSha ?? ''}
                        onChange={event =>
                          updateValue(requirement, { commitSha: event.target.value })
                        }
                        placeholder={t('todo.workflow_git_commit', '提交 SHA')}
                        className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-blue-500"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <div className="grid grid-cols-[110px_1fr] gap-2">
                      <select
                        value={value.provider ?? 'github'}
                        onChange={event =>
                          updateValue(requirement, {
                            provider: event.target.value as 'github' | 'gitlab',
                          })
                        }
                        className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
                      >
                        <option value="github">GitHub</option>
                        <option value="gitlab">GitLab</option>
                      </select>
                      <input
                        value={value.url ?? ''}
                        onChange={event => updateValue(requirement, { url: event.target.value })}
                        placeholder="https://"
                        className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-blue-500"
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <input
                        value={value.number ?? ''}
                        onChange={event => updateValue(requirement, { number: event.target.value })}
                        placeholder={t('todo.workflow_pr_number', '编号')}
                        className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-blue-500"
                      />
                      <input
                        value={value.headBranch ?? ''}
                        onChange={event =>
                          updateValue(requirement, { headBranch: event.target.value })
                        }
                        placeholder={t('todo.workflow_pr_head', '来源分支')}
                        className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-blue-500"
                      />
                      <input
                        value={value.baseBranch ?? ''}
                        onChange={event =>
                          updateValue(requirement, { baseBranch: event.target.value })
                        }
                        placeholder={t('todo.workflow_pr_base', '目标分支')}
                        className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-blue-500"
                      />
                    </div>
                    <input
                      value={value.commitSha ?? ''}
                      onChange={event =>
                        updateValue(requirement, { commitSha: event.target.value })
                      }
                      placeholder={t('todo.workflow_git_commit', '提交 SHA')}
                      className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-blue-500"
                    />
                  </div>
                )}
              </fieldset>
            )
          })}
          {action === 'force_advance' ? (
            <label className="block text-xs font-medium text-text-secondary">
              {t('todo.workflow_force_reason', '强制继续原因')}
              <textarea
                autoFocus
                value={reason}
                data-testid="workflow-stage-force-reason"
                onChange={event => onReasonChange(event.target.value)}
                className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </label>
          ) : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="h-9 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted disabled:opacity-40"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            data-testid="workflow-stage-completion-submit"
            disabled={!canSubmit}
            onClick={onSubmit}
            className="h-9 rounded-lg bg-text-primary px-4 text-sm font-medium text-background disabled:opacity-40"
          >
            {busy ? t('common.saving', '提交中…') : t('common.confirm')}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  )
}
