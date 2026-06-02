import { Check, ChevronDown } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UnifiedModel } from '@/types/api'
import { useOutsideClick } from './useOutsideClick'

interface ModelSelectorProps {
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  disabled: boolean
  onSelectModel: (model: UnifiedModel | null) => void
  menuPlacement?: 'above' | 'below'
  buttonClassName?: string
  menuClassName?: string
}

export function ModelSelector({
  models,
  selectedModel,
  disabled,
  onSelectModel,
  menuPlacement = 'above',
  buttonClassName = '',
  menuClassName = '',
}: ModelSelectorProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const closeMenu = useCallback(() => setOpen(false), [])

  useOutsideClick(containerRef, open, closeMenu)
  const menuPositionClass =
    menuPlacement === 'below' ? 'top-[52px] right-0' : 'bottom-[52px] right-0'

  return (
    <div ref={containerRef} className="relative">
      {open && (
        <div
          data-testid="model-selector-menu"
          className={[
            'absolute z-40 w-72 overflow-hidden rounded-2xl border border-border bg-base p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
            menuPositionClass,
            menuClassName,
          ].join(' ')}
        >
          <div className="px-4 pb-2 pt-1 text-[13px] font-semibold leading-[18px] text-text-muted">
            {t('workbench.select_model', '选择模型')}
          </div>
          <div className="space-y-1">
            {models.length === 0 ? (
              <div className="px-4 py-3 text-[13px] leading-[18px] text-text-muted">
                {t('workbench.no_models', '暂无可用模型')}
              </div>
            ) : (
              models.map(model => {
                const selected = model.name === selectedModel?.name && model.type === selectedModel?.type
                return (
                  <button
                    key={`${model.type}:${model.name}`}
                    type="button"
                    data-testid={`model-option-${model.name}`}
                    onClick={() => {
                      onSelectModel(model)
                      setOpen(false)
                    }}
                    className="flex min-h-10 w-full items-center gap-3 rounded-xl px-4 py-2 text-left text-[13px] font-medium leading-[18px] text-text-primary hover:bg-muted"
                  >
                    <span className="min-w-0 flex-1 truncate">{model.displayName || model.name}</span>
                    {selected && <Check className="h-4 w-4 shrink-0 text-text-secondary" />}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        data-testid="model-selector-button"
        onClick={() => !disabled && setOpen(current => !current)}
        disabled={disabled}
        className={[
          'flex h-8 min-w-8 items-center gap-1 rounded-full px-2 text-[13px] font-medium leading-[18px] text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
          buttonClassName,
        ].join(' ')}
        aria-expanded={open}
        aria-label={t('workbench.model_selector', '模型选择')}
      >
        <span>{selectedModel?.displayName || selectedModel?.name || t('workbench.default_model', '默认模型')}</span>
        <ChevronDown className="h-4 w-4 text-text-secondary" />
      </button>
    </div>
  )
}
