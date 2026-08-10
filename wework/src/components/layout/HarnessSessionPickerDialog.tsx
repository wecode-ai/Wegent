import { SquareTerminal, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { ExperimentalBadge } from '@/features/experimental-features/ExperimentalBadge'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { localHarnessLabel, type LocalHarnessId } from '@/lib/local-harness'

interface HarnessSessionPickerOption {
  id: LocalHarnessId
  disabled: boolean
}

interface HarnessSessionPickerDialogProps {
  open: boolean
  options: HarnessSessionPickerOption[]
  onClose: () => void
  onSelect: (id: LocalHarnessId) => void | Promise<void>
}

export function HarnessSessionPickerDialog({
  open,
  options,
  onClose,
  onSelect,
}: HarnessSessionPickerDialogProps) {
  const { t } = useTranslation('common')

  useEscapeKey(onClose, open)

  if (!open) return null

  return createPortal(
    <div
      data-testid="harness-session-picker-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
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
                {t('workbench.harness_session_picker_title', '新建 Harness 会话')}
              </h2>
              <ExperimentalBadge testId="harness-session-picker-experimental-badge" />
            </div>
            <p className="mt-1 text-sm text-text-secondary">
              {t(
                'workbench.harness_session_picker_description',
                '选择要在当前工作区中启动的编码工具。'
              )}
            </p>
          </div>
          <button
            type="button"
            data-testid="harness-session-picker-close-button"
            onClick={onClose}
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
              onClick={async () => {
                await onSelect(option.id)
                onClose()
              }}
              className="flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
            >
              <SquareTerminal className="h-4 w-4 shrink-0 text-text-secondary" />
              <span className="min-w-0 flex-1 truncate">{localHarnessLabel(option.id)}</span>
              <ExperimentalBadge testId={`harness-session-picker-option-${option.id}-badge`} />
            </button>
          ))}
        </div>
      </section>
    </div>,
    document.body
  )
}
