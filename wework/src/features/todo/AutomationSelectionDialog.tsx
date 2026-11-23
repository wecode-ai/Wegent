import { useTranslation } from '@/hooks/useTranslation'
import { Radio, RadioGroup } from '@wegent/collaboration/controls/RadioGroup'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useState } from 'react'
import { CloudTodoModal } from './CloudTodoModal'

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
      onSubmit={confirm}
      pending={saving}
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
        <RadioGroup
          value={String(selectedId ?? '')}
          name="automation-selection"
          aria-label={t('todo.automation_selection_title', '选择要运行的自动化')}
          onValueChange={next => {
            const candidate = candidates.find(candidate => String(candidate.id) === next)
            if (candidate) setSelectedId(candidate.id)
          }}
          render={<div />}
          className="mt-4 space-y-2"
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
                <Radio
                  value={String(candidate.id)}
                  data-testid={`automation-selection-option-${candidate.id}`}
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
        </RadioGroup>
        {error ? (
          <p className="mt-3 text-sm text-destructive" data-testid="automation-selection-error">
            {error}
          </p>
        ) : null}
      </div>
      <footer className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
        <ControlButton
          variant="outline"
          size="sm"
          type="button"
          data-testid="automation-selection-cancel"
          onClick={onCancel}
          disabled={saving}
          className="h-8 rounded-lg border border-border px-3.5 text-sm disabled:opacity-50"
        >
          {t('common.cancel', '取消')}
        </ControlButton>
        <ControlButton
          variant="primary"
          size="sm"
          type="submit"
          data-testid="automation-selection-confirm"
          disabled={!selectedId || saving}
          className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background disabled:opacity-50"
        >
          {saving
            ? t('todo.automation_selection_starting', '正在创建…')
            : t('todo.automation_selection_confirm', '创建并运行')}
        </ControlButton>
      </footer>
    </CloudTodoModal>
  )
}
