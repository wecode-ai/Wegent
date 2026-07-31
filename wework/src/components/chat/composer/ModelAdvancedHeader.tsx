import { ChevronRight, ChevronUp } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { FastModeIcon } from './FastModeIcon'

interface ModelAdvancedHeaderProps {
  disabled: boolean
  interacting: boolean
  powerViewOpen: boolean
  fastModeEnabled: boolean
  showFastModeToggle: boolean
  onClearSubmenu: () => void
  onToggle: () => void
  onToggleFastMode: () => void
}

export function ModelAdvancedHeader({
  disabled,
  interacting,
  powerViewOpen,
  fastModeEnabled,
  showFastModeToggle,
  onClearSubmenu,
  onToggle,
  onToggleFastMode,
}: ModelAdvancedHeaderProps) {
  const { t } = useTranslation('common')

  return (
    <div
      data-testid="model-advanced-row"
      onMouseEnter={onClearSubmenu}
      onPointerEnter={onClearSubmenu}
      className="flex h-8 items-center px-2 text-sm font-medium leading-[18px] text-text-muted"
    >
      {interacting ? (
        <>
          <span data-testid="reasoning-slider-faster-label">
            {t('workbench.reasoning_faster', 'Faster')}
          </span>
          <span data-testid="reasoning-slider-smarter-label" className="ml-auto">
            {t('workbench.reasoning_smarter', 'Smarter')}
          </span>
        </>
      ) : (
        <>
          <button
            type="button"
            data-testid="model-advanced-toggle"
            disabled={disabled}
            onFocus={onClearSubmenu}
            onClick={onToggle}
            className="-ml-2 inline-flex h-8 items-center gap-2 rounded-lg px-2 text-left text-text-muted hover:bg-muted hover:text-text-primary focus-visible:bg-muted focus-visible:text-text-primary focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>{t('workbench.model_advanced', '高级')}</span>
            {powerViewOpen ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronUp className="h-4 w-4" />
            )}
          </button>
          {powerViewOpen && showFastModeToggle ? (
            <button
              type="button"
              data-testid="model-advanced-fast-mode-toggle"
              aria-pressed={fastModeEnabled}
              aria-label={
                fastModeEnabled
                  ? t('workbench.speed_standard', '标准')
                  : t('workbench.speed_fast', '快速')
              }
              onClick={onToggleFastMode}
              className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary focus-visible:bg-muted focus-visible:text-text-primary focus-visible:outline-none"
            >
              <FastModeIcon
                data-testid="model-advanced-intelligence-icon"
                className={fastModeEnabled ? 'h-3.5 w-3.5 text-text-primary' : 'h-3.5 w-3.5'}
              />
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}
