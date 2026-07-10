import { Check } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export function ModelAutomaticReasoningOption() {
  const { t } = useTranslation('common')

  return (
    <section className="space-y-2">
      <h3 className="px-1 text-xs font-semibold text-text-muted">
        {t('workbench.reasoning_level')}
      </h3>
      <button
        type="button"
        data-testid="model-control-reasoning-auto"
        disabled
        className="flex h-11 min-w-[44px] items-center gap-2 rounded-full border border-[#1f2933] bg-[#1f2933] px-4 text-sm font-medium text-white disabled:cursor-default"
      >
        <span>{t('workbench.reasoning_auto')}</span>
        <Check className="h-4 w-4" />
      </button>
    </section>
  )
}
