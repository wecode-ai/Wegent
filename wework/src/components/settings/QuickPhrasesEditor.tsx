import {
  QuickPhrasesEditor as SharedQuickPhrasesEditor,
  type QuickPhrasesEditorProps,
} from '@wegent/collaboration/composer/QuickPhrasesEditor'
import { useTranslation } from '@/hooks/useTranslation'
export type { QuickPhraseChangeAction } from '@wegent/collaboration/composer/QuickPhrasesEditor'
export function QuickPhrasesEditor(props: Omit<QuickPhrasesEditorProps, 'translate'>) {
  const { t } = useTranslation('common')
  return (
    <SharedQuickPhrasesEditor
      {...props}
      translate={(key, fallback, options) => t(key, fallback ?? key, options)}
    />
  )
}
