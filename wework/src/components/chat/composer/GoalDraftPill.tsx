import {
  ComposerModePill as SharedComposerModePill,
  GoalDraftPill as SharedGoalDraftPill,
  type ComposerModePillProps,
  type GoalDraftPillProps,
} from '@wegent/collaboration/composer'
import { useTranslation } from '@/hooks/useTranslation'
export function ComposerModePill(props: Omit<ComposerModePillProps, 'translate'>) {
  const { t } = useTranslation('common')
  return (
    <SharedComposerModePill
      {...props}
      translate={(key, fallback, options) => t(key, fallback ?? key, options)}
    />
  )
}
export function GoalDraftPill(props: Omit<GoalDraftPillProps, 'translate'>) {
  const { t } = useTranslation('common')
  return (
    <SharedGoalDraftPill
      {...props}
      translate={(key, fallback, options) => t(key, fallback ?? key, options)}
    />
  )
}
