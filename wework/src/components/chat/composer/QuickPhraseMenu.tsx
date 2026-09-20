import {
  QuickPhraseMenu as SharedQuickPhraseMenu,
  type QuickPhraseMenuProps,
} from '@wegent/collaboration/composer/QuickPhraseMenu'
import { useTranslation } from '@/hooks/useTranslation'
import { track } from '@/telemetry/client'
import { navigateTo } from '@/lib/navigation'
import { getAppPreferences, updateAppPreferences } from '@/desktop/appPreferences'
import { useQuickPhrases } from '@/hooks/useQuickPhrases'
import { desktopFileUrl } from '../assistantMarkdownLinks'

export function QuickPhraseMenu(
  props: Pick<QuickPhraseMenuProps, 'disabled' | 'compact' | 'projectPhrases' | 'onSelect'>
) {
  const { t } = useTranslation('common')
  const globalPhrases = useQuickPhrases()
  return (
    <SharedQuickPhraseMenu
      {...props}
      translate={(key, fallback, options) => t(key, fallback ?? key, options)}
      globalPhrases={globalPhrases}
      attachmentUrl={desktopFileUrl}
      onSelect={phrase => {
        props.onSelect(phrase)
        track('quick_phrase_used', { mode: phrase.mode })
      }}
      onManage={() => navigateTo('/settings/personal/quick-phrases')}
      onRemoveStash={async phrase => {
        const preferences = await getAppPreferences()
        await updateAppPreferences({
          quickPhrases: preferences.quickPhrases.filter(item => item.id !== phrase.id),
        })
      }}
      onClearStash={async () => {
        const preferences = await getAppPreferences()
        await updateAppPreferences({
          quickPhrases: preferences.quickPhrases.filter(item => !item.id.startsWith('stash-')),
        })
      }}
    />
  )
}
