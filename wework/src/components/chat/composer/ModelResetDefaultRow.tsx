import { RotateCcw } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

interface ModelResetDefaultRowProps {
  disabled: boolean
  onClearSubmenu: () => void
  onReset: () => void
}

export function ModelResetDefaultRow({
  disabled,
  onClearSubmenu,
  onReset,
}: ModelResetDefaultRowProps) {
  const { t } = useTranslation('common')

  return (
    <div
      data-testid="model-reset-default-row"
      onMouseEnter={onClearSubmenu}
      onPointerEnter={onClearSubmenu}
      className="flex h-8 items-center px-1"
    >
      <button
        type="button"
        data-testid="model-reset-default-button"
        disabled={disabled}
        onFocus={onClearSubmenu}
        onClick={onReset}
        className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] font-medium leading-[18px] text-text-muted hover:bg-muted hover:text-text-primary focus-visible:bg-muted focus-visible:text-text-primary focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="min-w-0 flex-1 truncate">
          {t('workbench.reset_default_model_settings', '重置为默认设置')}
        </span>
        <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
      </button>
    </div>
  )
}
