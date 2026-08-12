import { SquareTerminal, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useMemo, useRef, useState } from 'react'
import { ExperimentalBadge } from '@/features/experimental-features/ExperimentalBadge'
import type { LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { localHarnessLabel, type LocalHarnessId } from '@/lib/local-harness'
import { cn } from '@/lib/utils'
import { WorkbenchHarnessModelSelector } from './WorkbenchHarnessModelSelector'

interface HarnessSessionPickerOption {
  id: LocalHarnessId
  disabled: boolean
  models: LocalHarnessModelOption[]
  selectedModel: LocalHarnessModelOption | null
}

interface HarnessSessionPickerDialogProps {
  open: boolean
  options: HarnessSessionPickerOption[]
  onClose: () => void
  onSelect: (id: LocalHarnessId, model: LocalHarnessModelOption | null) => void | Promise<void>
}

export function HarnessSessionPickerDialog({
  open,
  options,
  onClose,
  onSelect,
}: HarnessSessionPickerDialogProps) {
  const { t } = useTranslation('common')
  const [selectedHarnessId, setSelectedHarnessId] = useState<LocalHarnessId | null>(null)
  const [selectedModelKey, setSelectedModelKey] = useState<string | null | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)
  const submissionGenerationRef = useRef(0)
  const firstAvailableOption = useMemo(() => options.find(option => !option.disabled), [options])
  const selectedOption =
    options.find(option => option.id === selectedHarnessId && !option.disabled) ??
    firstAvailableOption ??
    null
  const effectiveSelectedModelKey =
    selectedModelKey === undefined ? (selectedOption?.selectedModel?.key ?? null) : selectedModelKey
  const selectedModel =
    selectedOption?.models.find(model => model.key === effectiveSelectedModelKey) ?? null
  const closeDialog = () => {
    submissionGenerationRef.current += 1
    setSelectedHarnessId(null)
    setSelectedModelKey(undefined)
    setSubmitting(false)
    onClose()
  }

  useEscapeKey(closeDialog, open)

  if (!open) return null

  return createPortal(
    <div
      data-testid="harness-session-picker-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
      onMouseDown={event => {
        if (event.target === event.currentTarget) closeDialog()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="harness-session-picker-title"
        data-testid="harness-session-picker"
        className="w-full max-w-[420px] rounded-xl border border-border bg-popover p-5 text-text-primary shadow-xl"
      >
        <header className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 id="harness-session-picker-title" className="heading-small text-text-primary">
                {t('workbench.harness_session_picker_title', '新建编码会话')}
              </h2>
              <ExperimentalBadge testId="harness-session-picker-experimental-badge" />
            </div>
            <p className="mt-1 text-sm text-text-secondary">
              {t(
                'workbench.harness_session_picker_description',
                '选择编码工具和模型，然后在当前工作区中创建会话。'
              )}
            </p>
          </div>
          <button
            type="button"
            data-testid="harness-session-picker-close-button"
            onClick={closeDialog}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
            aria-label={t('common.close', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="mt-5 flex flex-col gap-1">
          {options.map(option => (
            <button
              key={option.id}
              type="button"
              data-testid={`harness-session-picker-option-${option.id}`}
              disabled={option.disabled}
              aria-pressed={selectedOption?.id === option.id}
              onClick={() => {
                setSelectedHarnessId(option.id)
                setSelectedModelKey(option.selectedModel?.key ?? null)
              }}
              className={cn(
                'flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent',
                selectedOption?.id === option.id && 'bg-muted'
              )}
            >
              <SquareTerminal className="h-4 w-4 shrink-0 text-text-secondary" />
              <span className="min-w-0 flex-1 truncate">{localHarnessLabel(option.id)}</span>
              <ExperimentalBadge testId={`harness-session-picker-option-${option.id}-badge`} />
            </button>
          ))}
        </div>
        {selectedOption && (
          <div className="mt-4 border-t border-border pt-4">
            <div className="mb-2 text-sm font-medium text-text-primary">
              {t('workbench.harness_session_model_label', '模型')}
            </div>
            <WorkbenchHarnessModelSelector
              harnessId={selectedOption.id}
              models={selectedOption.models}
              selectedModel={selectedModel}
              onModelChange={model => setSelectedModelKey(model?.key ?? null)}
              testId="harness-session-picker-model-selector"
              optionTestIdPrefix="harness-session-picker-model-option"
            />
            <p className="mt-2 text-xs text-text-secondary">
              {t(
                'workbench.harness_session_model_description',
                '模型只应用于本次会话；不指定时使用编码工具自己的模型配置。'
              )}
            </p>
          </div>
        )}
        <footer className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="harness-session-picker-cancel-button"
            onClick={closeDialog}
            disabled={submitting}
            className="flex h-8 items-center rounded-lg px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="harness-session-picker-create-button"
            disabled={!selectedOption || submitting}
            onClick={async () => {
              if (!selectedOption || submitting) return
              const submissionGeneration = submissionGenerationRef.current + 1
              submissionGenerationRef.current = submissionGeneration
              setSubmitting(true)
              try {
                await onSelect(selectedOption.id, selectedModel)
                if (submissionGenerationRef.current === submissionGeneration) {
                  closeDialog()
                }
              } finally {
                if (submissionGenerationRef.current === submissionGeneration) {
                  setSubmitting(false)
                }
              }
            }}
            className="flex h-8 items-center rounded-lg bg-text-primary px-3 text-sm text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {submitting
              ? t('workbench.harness_session_creating', '正在创建…')
              : t('workbench.harness_session_create', '创建会话')}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  )
}
