import { useContext, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { updateAppPreferences, type AppPreferencesPatch } from '@/desktop/appPreferences'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './settings-ui'

export function ReplyPredictionSettings() {
  const { t } = useTranslation('common')
  const state = useAppPreferencesState()
  const workbench = useContext(WorkbenchContext)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const models = workbench?.projectChat.models ?? []
  const model = state?.preferences.replyPredictionModel
  const key = model ? `${model.modelType}:${model.modelName}` : ''
  const available = models.some(
    candidate => `${candidate.type}:${candidate.name}` === key && candidate.isActive !== false
  )
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
    <section data-testid="reply-prediction-settings" className="mt-8">
      <h2 className="mb-3 text-sm font-medium text-text-primary">
        {t('workbench.reply_prediction_title')}
      </h2>
      <SettingsGroup>
        <SettingsRow
          label={t('workbench.reply_prediction_enable')}
          description={t('workbench.reply_prediction_description')}
          control={
            <SettingsSwitch
              checked={state?.preferences.replyPredictionsEnabled ?? false}
              disabled={
                !state?.loaded ||
                (!available && !state.preferences.replyPredictionsEnabled) ||
                saving
              }
              onCheckedChange={enabled => void save({ replyPredictionsEnabled: enabled })}
              aria-label={t('workbench.reply_prediction_enable')}
              data-testid="reply-prediction-enabled"
            />
          }
        />
        <SettingsRow
          label={t('workbench.reply_prediction_model')}
          control={
            <select
              value={key}
              disabled={!state?.loaded || saving}
              aria-label={t('workbench.reply_prediction_model')}
              data-testid="reply-prediction-model"
              className="h-8 max-w-full rounded-md border border-border bg-background px-2 text-sm text-text-primary"
              onChange={event => {
                const selected = models.find(
                  candidate => `${candidate.type}:${candidate.name}` === event.target.value
                )
                const execution = selected ? selectedModelExecutionFields(selected, {}) : null
                void save({
                  replyPredictionsEnabled: selected
                    ? model
                      ? state!.preferences.replyPredictionsEnabled
                      : true
                    : false,
                  replyPredictionModel:
                    selected && execution
                      ? {
                          modelName: selected.name,
                          modelType: selected.type,
                          executionModelId: execution.modelId ?? '',
                          executionModelType: execution.modelType ?? null,
                          options: execution.modelOptions,
                        }
                      : null,
                })
              }}
            >
              <option value="">{t('workbench.reply_prediction_choose_model')}</option>
              {model && !available && (
                <option value={key}>
                  {model.modelName} · {t('workbench.reply_prediction_unavailable')}
                </option>
              )}
              {models
                .filter(candidate => candidate.isActive !== false)
                .map(candidate => (
                  <option
                    key={`${candidate.type}:${candidate.name}`}
                    value={`${candidate.type}:${candidate.name}`}
                  >
                    {candidate.displayName || candidate.name}
                  </option>
                ))}
            </select>
          }
        />
        {error && (
          <p role="alert" className="text-sm text-red-500">
            {t('workbench.reply_prediction_save_failed')}
          </p>
        )}
        {model && !available && (
          <p role="status" className="text-sm text-text-muted">
            {t('workbench.reply_prediction_unavailable')}
          </p>
        )}
      </SettingsGroup>
    </section>
  )
}
