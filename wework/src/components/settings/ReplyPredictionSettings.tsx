import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { updateAppPreferences, type AppPreferencesPatch } from '@/desktop/appPreferences'
import { SettingsRow, SettingsSwitch } from './settings-ui'

export function ReplyPredictionSettings() {
  const { t } = useTranslation('common')
  const state = useAppPreferencesState()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  async function save(patch: AppPreferencesPatch) {
    setSaving(true)
    setError(false)
    try {
      await updateAppPreferences(patch)
    } catch {
      setError(true)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div data-testid="reply-prediction-settings">
      <SettingsRow
        className="py-4"
        labelClassName="font-normal"
        label={t('workbench.reply_prediction_enable')}
        description={t('workbench.reply_prediction_description')}
        control={
          <SettingsSwitch
            checked={state?.preferences.replyPredictionsEnabled ?? false}
            disabled={!state?.loaded || saving}
            onCheckedChange={enabled => void save({ replyPredictionsEnabled: enabled })}
            aria-label={t('workbench.reply_prediction_enable')}
            data-testid="reply-prediction-enabled"
          />
        }
      />
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {t('workbench.reply_prediction_save_failed')}
        </p>
      )}
    </div>
  )
}
