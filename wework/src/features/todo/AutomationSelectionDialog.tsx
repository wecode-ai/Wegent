import { useState } from 'react'
import { CloudTodoModal } from './CloudTodoModal'
import { useTranslation } from '@/hooks/useTranslation'

export interface AutomationSelectionCandidate {
  id: string
  name: string
  description: string
}

export function AutomationSelectionDialog({
  candidates,
  onCancel,
  onConfirm,
}: {
  candidates: AutomationSelectionCandidate[]
  onCancel: () => void
  onConfirm: (automationId: string) => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [selectedId, setSelectedId] = useState(candidates[0]?.id ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    if (!selectedId || saving) return
    setSaving(true)
    setError(null)
    try {
      await onConfirm(selectedId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSaving(false)
    }
  }

  return (
    <CloudTodoModal
      title={t('todo.automation_selection_title', '选择要运行的自动化')}
      onClose={onCancel}
    >
      <div className="min-h-0 overflow-y-auto px-5 py-4">
        <p className="text-sm text-text-secondary">
          {t(
            'todo.automation_selection_description',
            '当前 Issue 同时命中多个自动化。请选择一个流程，本次只会运行所选自动化。'
          )}
        </p>
        <div
          className="mt-4 space-y-2"
          role="radiogroup"
          aria-label={t('todo.automation_selection_title', '选择要运行的自动化')}
          data-testid="automation-selection-options"
        >
          {candidates.map(candidate => {
            const selected = candidate.id === selectedId
            return (
              <label
                key={candidate.id}
                className={`flex cursor-pointer gap-3 rounded-xl border px-3 py-3 ${
                  selected
                    ? 'border-text-primary bg-muted'
                    : 'border-border hover:border-text-muted'
                }`}
              >
                <input
                  type="radio"
                  name="automation-selection"
                  value={candidate.id}
                  checked={selected}
                  onChange={() => setSelectedId(candidate.id)}
                  data-testid={`automation-selection-option-${candidate.id}`}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text-primary">
                    {candidate.name}
                  </span>
                  {candidate.description ? (
                    <span className="mt-1 block text-sm text-text-secondary">
                      {candidate.description}
                    </span>
                  ) : null}
                </span>
              </label>
            )
          })}
        </div>
        {error ? (
          <p className="mt-3 text-sm text-destructive" data-testid="automation-selection-error">
            {error}
          </p>
        ) : null}
      </div>
      <footer className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
        <button
          type="button"
          data-testid="automation-selection-cancel"
          onClick={onCancel}
          disabled={saving}
          className="h-8 rounded-lg border border-border px-3.5 text-sm disabled:opacity-50"
        >
          {t('common.cancel', '取消')}
        </button>
        <button
          type="button"
          data-testid="automation-selection-confirm"
          onClick={() => void confirm()}
          disabled={!selectedId || saving}
          className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background disabled:opacity-50"
        >
          {saving
            ? t('todo.automation_selection_starting', '正在创建…')
            : t('todo.automation_selection_confirm', '创建并运行')}
        </button>
      </footer>
    </CloudTodoModal>
  )
}
