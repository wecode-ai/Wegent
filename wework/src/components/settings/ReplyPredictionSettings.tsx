import { useContext, useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { updateAppPreferences, type AppPreferencesPatch } from '@/desktop/appPreferences'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import { SettingsRow, SettingsSwitch } from './settings-ui'

export function ReplyPredictionSettings() {
  const { t } = useTranslation('common')
  const state = useAppPreferencesState()
  const workbench = useContext(WorkbenchContext)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const models = workbench?.projectChat.models ?? []
  const requestCatalogs = workbench?.projectChat.requestCatalogs
  useEffect(() => {
    requestCatalogs?.()
  }, [requestCatalogs])
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
      {state?.preferences.replyPredictionsEnabled && (
        <div className="px-4 pb-3">
          <div className="ml-3 flex items-center justify-between gap-4 rounded-lg bg-muted/50 px-3 py-2.5 max-sm:ml-0 max-sm:flex-col max-sm:items-stretch">
            <div className="min-w-0">
              <div className="text-xs font-medium text-text-primary">
                {t('workbench.reply_prediction_model')}
              </div>
              <p className="mt-0.5 text-xs text-text-secondary">
                {t('workbench.reply_prediction_model_description')}
              </p>
            </div>
            <select
              value={key}
              disabled={!state?.loaded || saving}
              aria-label={t('workbench.reply_prediction_model')}
              data-testid="reply-prediction-model"
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-text-primary md:w-[220px]"
              onChange={event => {
                const selected = models.find(
                  candidate => `${candidate.type}:${candidate.name}` === event.target.value
                )
                const execution = selected ? selectedModelExecutionFields(selected, {}) : null
                void save({
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
              <option value="">{t('workbench.friendly_task_titles_model_task')}</option>
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
          </div>
        </div>
      )}
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
    </div>
  )
}
