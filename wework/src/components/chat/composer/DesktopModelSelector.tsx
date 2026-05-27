import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useOutsideClick } from './useOutsideClick'

const intelligenceOptions = [
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
  ['ultra', '超高'],
] as const

export function DesktopModelSelector() {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const closeMenu = useCallback(() => setOpen(false), [])

  useOutsideClick(containerRef, open, closeMenu)

  return (
    <div ref={containerRef} className="relative">
      {open && (
        <div
          data-testid="model-selector-menu"
          className="absolute bottom-[52px] right-0 z-40 w-72 overflow-hidden rounded-2xl border border-border bg-base p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
        >
          <div className="px-4 pb-2 pt-1 text-sm font-semibold text-text-muted">
            {t('workbench.intelligence', '智能')}
          </div>
          <div className="space-y-1">
            {intelligenceOptions.map(([option, fallback]) => {
              const selected = option === 'medium'
              return (
                <button
                  key={option}
                  type="button"
                  data-testid={`intelligence-option-${option}`}
                  className="flex h-10 w-full items-center rounded-lg px-4 text-left text-base font-semibold text-text-primary hover:bg-muted"
                >
                  <span className="flex-1">{t(`workbench.intelligence_${option}`, fallback)}</span>
                  {selected && <Check className="h-5 w-5 text-text-secondary" />}
                </button>
              )
            })}
          </div>
          <div className="mx-2 my-2 border-t border-border" />
          <button
            type="button"
            data-testid="model-family-menu-button"
            className="flex h-11 w-full items-center rounded-xl bg-muted px-4 text-left text-base font-medium text-text-primary"
          >
            <span className="flex-1">{t('workbench.model_family_gpt55', 'GPT-5.5')}</span>
            <ChevronRight className="h-5 w-5 text-text-muted" />
          </button>
          <button
            type="button"
            data-testid="speed-menu-button"
            className="mt-1 flex h-11 w-full items-center rounded-xl px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
          >
            <span className="flex-1">{t('workbench.speed', '速度')}</span>
            <ChevronRight className="h-5 w-5 text-text-muted" />
          </button>
        </div>
      )}
      <button
        type="button"
        data-testid="model-selector-button"
        onClick={() => setOpen(current => !current)}
        className="flex h-11 min-w-[44px] items-center gap-1 rounded-full px-2 text-sm font-medium text-text-primary hover:bg-muted"
        aria-expanded={open}
        aria-label={t('workbench.model_selector', '模型选择')}
      >
        <span>{t('workbench.default_model', '5.5 中')}</span>
        <ChevronDown className="h-4 w-4 text-text-secondary" />
      </button>
    </div>
  )
}
