import type { ModelOptions } from '@wegent/chat-core/models'
import { Check } from 'lucide-react'
import type { CollaborationTranslate } from '../i18n'
import { Button as ControlButton } from '../markdown/Button'
import { selectedControlOption } from './model-selector-utils'
import type { ModelControlConfig } from './model-ui'

export function ModelSelectorMobileControl({
  control,
  options,
  translate: t,
  onSelectOption,
}: {
  control: ModelControlConfig
  options: ModelOptions
  translate: CollaborationTranslate
  onSelectOption: (control: string, value: string) => void
}) {
  return (
    <section key={control.id} className="space-y-2">
      <h3 className="px-1 text-xs font-semibold text-text-secondary">
        {control.labelKey ? t(control.labelKey, control.label) : control.label}
      </h3>
      <div className="scrollbar-none flex gap-2 overflow-x-auto pb-1">
        {control.options
          .slice()
          .sort((a, b) => a.order - b.order)
          .map(option => {
            const selected = selectedControlOption(control, options)?.value === option.value
            return (
              <ControlButton
                variant="unstyled"
                key={option.value}
                type="button"
                data-testid={`model-control-${control.id}-${option.value}`}
                onClick={() => onSelectOption(control.id, option.value)}
                className={[
                  'flex h-11 min-w-[44px] shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium',
                  selected
                    ? 'border-text-primary bg-text-primary text-background'
                    : 'border-border bg-surface text-text-secondary',
                ].join(' ')}
              >
                <span>{option.labelKey ? t(option.labelKey, option.label) : option.label}</span>
                {selected && <Check className="h-4 w-4" />}
              </ControlButton>
            )
          })}
      </div>
    </section>
  )
}
