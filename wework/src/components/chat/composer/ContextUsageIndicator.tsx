import { ContextUsageIndicator as SharedContextUsageIndicator } from '@wegent/collaboration/composer/ContextUsageIndicator'
import type { ContextUsageIndicatorProps } from '@wegent/collaboration/composer/ContextUsageIndicator'
import { useTranslation } from '@/hooks/useTranslation'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
export function ContextUsageIndicator(
  props: Omit<ContextUsageIndicatorProps, 'translate' | 'compactionThreshold'>
) {
  const { t } = useTranslation('common')
  const preferences = useAppPreferencesState()
  return (
    <SharedContextUsageIndicator
      {...props}
      compactionThreshold={preferences?.preferences.contextCompactionThreshold}
      translate={(key, fallback, options) => String(t(key, { ...options, defaultValue: fallback }))}
    />
  )
}
