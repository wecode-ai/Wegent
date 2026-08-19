import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Trash2, X } from 'lucide-react'
import type { DeliverableRequirement, DeliverableValueType } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import {
  createWorkflowDeliverableRequirement,
  workflowDeliverableTypeLabel,
} from './workflowDeliverables'

interface WorkflowDeliverableRequirementsDialogProps {
  requirements: DeliverableRequirement[]
  onClose: () => void
  onSave: (requirements: DeliverableRequirement[]) => void
}

export function WorkflowDeliverableRequirementsDialog({
  requirements,
  onClose,
  onSave,
}: WorkflowDeliverableRequirementsDialogProps) {
  const { t } = useTranslation('common')
  const [drafts, setDrafts] = useState<DeliverableRequirement[]>(() =>
    requirements.map(requirement => ({ ...requirement }))
  )
  const canSave = drafts.every(draft => Boolean(draft.name.trim()))

  const updateDraft = (id: string, patch: Partial<DeliverableRequirement>) => {
    setDrafts(current => current.map(draft => (draft.id === id ? { ...draft, ...patch } : draft)))
  }

  const updateType = (id: string, valueType: DeliverableValueType) => {
    const draft = drafts.find(value => value.id === id)
    updateDraft(id, {
      value_type: valueType,
      file_constraints:
        valueType === 'file'
          ? (draft?.file_constraints ?? {
              accepted_types: [],
              min_files: 1,
              max_files: 1,
            })
          : null,
    })
  }

  return createPortal(
    <div
      className="fixed inset-0 z-system flex items-center justify-center bg-black/35 p-6 backdrop-blur-sm"
      onMouseDown={event => event.currentTarget === event.target && onClose()}
    >
      <section
        data-testid="workflow-deliverable-requirements-dialog"
        className="flex max-h-[calc(100vh-72px)] w-[640px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-2xl bg-background shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-text-primary">
            {t('todo.workflow_deliverable_dialog_title', '编辑交付物清单')}
          </h2>
          <button
            type="button"
            data-testid="workflow-deliverable-requirements-close"
            aria-label={t('common.close', '关闭')}
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {drafts.map((draft, index) => (
            <fieldset
              key={draft.id}
              data-testid={`workflow-deliverable-requirement-${draft.id}`}
              className="rounded-xl border border-border p-3"
            >
              <legend className="px-1 text-xs font-medium text-text-muted">
                {t('todo.workflow_deliverable_numbered', '交付物 {{number}}', {
                  number: index + 1,
                })}
              </legend>
              <div className="flex items-start gap-2">
                <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_140px] gap-2">
                  <label className="block text-xs font-medium text-text-secondary">
                    {t('todo.workflow_deliverable_name_label', '交付物名称')}
                    <input
                      autoFocus={index === drafts.length - 1 && !draft.name}
                      value={draft.name}
                      data-testid={`workflow-deliverable-requirement-name-${draft.id}`}
                      onChange={event => updateDraft(draft.id, { name: event.target.value })}
                      placeholder={t('todo.workflow_deliverable_name_placeholder', '交付物名称')}
                      className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-blue-500"
                    />
                  </label>
                  <label className="block text-xs font-medium text-text-secondary">
                    {t('todo.workflow_deliverable_type_label', '交付类型')}
                    <select
                      value={draft.value_type}
                      data-testid={`workflow-deliverable-requirement-type-${draft.id}`}
                      onChange={event =>
                        updateType(draft.id, event.target.value as DeliverableValueType)
                      }
                      className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-blue-500"
                    >
                      {(
                        [
                          'text',
                          'file',
                          'code_snapshot',
                          'git_branch',
                          'pull_request',
                          'url',
                        ] as DeliverableValueType[]
                      ).map(valueType => (
                        <option key={valueType} value={valueType}>
                          {workflowDeliverableTypeLabel(valueType, t)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="col-span-2 block text-xs font-medium text-text-secondary">
                    {t('todo.workflow_deliverable_description_label', '验收说明')}
                    <textarea
                      value={draft.description}
                      data-testid={`workflow-deliverable-requirement-description-${draft.id}`}
                      onChange={event => updateDraft(draft.id, { description: event.target.value })}
                      placeholder={t(
                        'todo.workflow_deliverable_description_placeholder',
                        '验收说明（可选）'
                      )}
                      className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-blue-500"
                    />
                  </label>
                </div>
                <button
                  type="button"
                  data-testid={`workflow-deliverable-requirement-remove-${draft.id}`}
                  aria-label={t('todo.workflow_remove_deliverable', '删除交付物')}
                  onClick={() =>
                    setDrafts(current => current.filter(value => value.id !== draft.id))
                  }
                  className="mt-5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </fieldset>
          ))}
          <button
            type="button"
            data-testid="workflow-deliverable-requirement-add"
            onClick={() =>
              setDrafts(current => [...current, createWorkflowDeliverableRequirement(current)])
            }
            className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-sm text-text-secondary hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            {t('todo.workflow_add_another_deliverable', '继续添加交付物')}
          </button>
        </div>

        <footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted"
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="workflow-deliverable-requirements-save"
            disabled={!canSave}
            onClick={() => onSave(drafts.map(draft => ({ ...draft, name: draft.name.trim() })))}
            className="h-8 rounded-lg bg-text-primary px-3 text-sm text-background disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('common.save', '保存')}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  )
}
