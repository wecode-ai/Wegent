import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { getAppPreferences, updateAppPreferences, type QuickPhrase } from '@/desktop/appPreferences'
import { SettingsPage, SettingsPageHeader } from './settings-ui'
import { track } from '@/telemetry/client'
import { QuickPhrasesEditor, type QuickPhraseChangeAction } from './QuickPhrasesEditor'

export function QuickPhrasesSettingsPage() {
  const { t } = useTranslation('common')
  const [phrases, setPhrases] = useState<QuickPhrase[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    void getAppPreferences().then(value => setPhrases(value.quickPhrases))
  }, [])

  const save = async (next: QuickPhrase[], action: QuickPhraseChangeAction) => {
    setPhrases(next)
    try {
      await updateAppPreferences({ quickPhrases: next })
      setError('')
      track('feature_action_completed', { domain: 'quick_phrase', action })
    } catch {
      track('operation_failed', { operation: 'quick_phrase_action' })
      setError(t('workbench.quick_phrases_save_error', '无法保存快捷短语，请重试'))
    }
  }
  return (
    <SettingsPage data-testid="quick-phrases-settings-page">
      <SettingsPageHeader
        title={t('workbench.quick_phrases', '快捷短语')}
        description={t('workbench.quick_phrases_description', '创建和排序输入框中常用的短语。')}
      />
      {error && (
        <div
          role="alert"
          className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      <QuickPhrasesEditor phrases={phrases} onChange={(next, action) => void save(next, action)} />
    </SettingsPage>
  )
}
