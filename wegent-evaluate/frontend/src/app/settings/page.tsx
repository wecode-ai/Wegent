'use client'

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { triggerSync, getSyncStatus } from '@/apis/sync'
import { triggerEvaluation, getEvaluationStatus } from '@/apis/evaluation'
import { getSettingsConfig, SettingsConfig } from '@/apis/settings'
import { Loader2 } from 'lucide-react'

// Format date to YYYY-MM-DD HH:mm:ss
function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

// Parse cron expression to get hour for display
function parseCronHour(cronExpr: string): string {
  const parts = cronExpr.split(' ')
  if (parts.length >= 2) {
    const hour = parseInt(parts[1])
    if (!isNaN(hour)) {
      return `${hour}:00 AM`
    }
  }
  return cronExpr
}

export default function SettingsPage() {
  const { t } = useTranslation()

  // Settings config state
  const [config, setConfig] = useState<SettingsConfig | null>(null)
  const [configLoading, setConfigLoading] = useState(true)

  // Sync state
  const [syncStartDate, setSyncStartDate] = useState('')
  const [syncEndDate, setSyncEndDate] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Evaluation state
  const [evalStartId, setEvalStartId] = useState('')
  const [evalEndId, setEvalEndId] = useState('')
  const [forceEval, setForceEval] = useState(false)
  const [evaluating, setEvaluating] = useState(false)
  const [evalMessage, setEvalMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Fetch settings config on mount
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const data = await getSettingsConfig()
        setConfig(data)
      } catch (error) {
        console.error('Failed to fetch settings config:', error)
      } finally {
        setConfigLoading(false)
      }
    }
    fetchConfig()
  }, [])

  // Handle sync trigger
  const handleTriggerSync = async () => {
    if (!syncStartDate || !syncEndDate) {
      setSyncMessage({ type: 'error', text: 'Please select both start and end dates' })
      return
    }

    setSyncing(true)
    setSyncMessage(null)

    try {
      const result = await triggerSync({
        start_time: formatDateTime(syncStartDate),
        end_time: formatDateTime(syncEndDate),
      })

      // Poll for completion
      const pollStatus = async () => {
        try {
          const statusResult = await getSyncStatus(result.sync_id)
          if (statusResult.status === 'completed') {
            setSyncing(false)
            setSyncMessage({
              type: 'success',
              text: `Sync completed! ${statusResult.records_synced || 0} records synced.`,
            })
          } else if (statusResult.status === 'failed') {
            setSyncing(false)
            setSyncMessage({
              type: 'error',
              text: `Sync failed: ${statusResult.error || 'Unknown error'}`,
            })
          } else {
            setTimeout(pollStatus, 2000)
          }
        } catch {
          setSyncing(false)
          setSyncMessage({ type: 'error', text: 'Failed to check sync status' })
        }
      }
      pollStatus()
    } catch (err) {
      setSyncing(false)
      setSyncMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to trigger sync',
      })
    }
  }

  // Handle evaluation trigger
  const handleTriggerEvaluation = async () => {
    if (!evalStartId || !evalEndId) {
      setEvalMessage({ type: 'error', text: 'Please enter both start and end IDs' })
      return
    }

    const startId = parseInt(evalStartId)
    const endId = parseInt(evalEndId)

    if (isNaN(startId) || isNaN(endId)) {
      setEvalMessage({ type: 'error', text: 'Invalid ID format' })
      return
    }

    if (startId > endId) {
      setEvalMessage({ type: 'error', text: 'Start ID must be less than or equal to End ID' })
      return
    }

    setEvaluating(true)
    setEvalMessage(null)

    try {
      const result = await triggerEvaluation('range', {
        start_id: startId,
        end_id: endId,
        force: forceEval,
      })

      // Poll for completion
      const pollStatus = async () => {
        try {
          const statusResult = await getEvaluationStatus(result.job_id)
          if (statusResult.status === 'completed') {
            setEvaluating(false)
            setEvalMessage({
              type: 'success',
              text: `Evaluation completed! ${statusResult.processed || 0} records evaluated.`,
            })
          } else if (statusResult.status === 'failed') {
            setEvaluating(false)
            setEvalMessage({
              type: 'error',
              text: `Evaluation failed: ${statusResult.error || 'Unknown error'}`,
            })
          } else {
            setTimeout(pollStatus, 2000)
          }
        } catch {
          setEvaluating(false)
          setEvalMessage({ type: 'error', text: 'Failed to check evaluation status' })
        }
      }
      pollStatus()
    } catch (err) {
      setEvaluating(false)
      setEvalMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to trigger evaluation',
      })
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('settings.title')}</h1>

      {/* Manual Sync */}
      <div className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">{t('settings.manualSync')}</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {t('settings.syncDescription')}
        </p>
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm">{t('common.start')}:</label>
            <input
              type="datetime-local"
              value={syncStartDate}
              onChange={(e) => setSyncStartDate(e.target.value)}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm">{t('common.end')}:</label>
            <input
              type="datetime-local"
              value={syncEndDate}
              onChange={(e) => setSyncEndDate(e.target.value)}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={handleTriggerSync}
            disabled={syncing}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {syncing && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('dashboard.triggerSync')}
          </button>
        </div>
        {syncMessage && (
          <div
            className={`mt-4 rounded-md p-3 text-sm ${
              syncMessage.type === 'success'
                ? 'bg-green-50 text-green-700 border border-green-200'
                : 'bg-red-50 text-red-700 border border-red-200'
            }`}
          >
            {syncMessage.text}
          </div>
        )}
      </div>

      {/* Manual Evaluation */}
      <div className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">{t('settings.manualEvaluation')}</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {t('settings.evaluationDescription')}
        </p>
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm">{t('settings.startId')}:</label>
            <input
              type="number"
              value={evalStartId}
              onChange={(e) => setEvalStartId(e.target.value)}
              className="w-32 rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="1"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm">{t('settings.endId')}:</label>
            <input
              type="number"
              value={evalEndId}
              onChange={(e) => setEvalEndId(e.target.value)}
              className="w-32 rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="100"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="forceEval"
              checked={forceEval}
              onChange={(e) => setForceEval(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <label htmlFor="forceEval" className="text-sm">
              {t('settings.forceReEvaluate')}
            </label>
          </div>
          <button
            onClick={handleTriggerEvaluation}
            disabled={evaluating}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {evaluating && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('dashboard.triggerEvaluation')}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t('settings.forceReEvaluateHint')}
        </p>
        {evalMessage && (
          <div
            className={`mt-4 rounded-md p-3 text-sm ${
              evalMessage.type === 'success'
                ? 'bg-green-50 text-green-700 border border-green-200'
                : 'bg-red-50 text-red-700 border border-red-200'
            }`}
          >
            {evalMessage.text}
          </div>
        )}
      </div>

      {/* Sync Configuration */}
      <div className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">{t('settings.syncConfig')}</h2>
        {configLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading')}...
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('settings.apiBaseUrl')}
              </label>
              <input
                type="text"
                disabled
                value={config?.sync.external_api_base_url || '-'}
                className="w-full rounded-md border bg-secondary px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('settings.syncCron')}
              </label>
              <input
                type="text"
                disabled
                value={config?.sync.sync_cron_expression || '-'}
                className="w-full rounded-md border bg-secondary px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t('settings.runsDaily')} {config ? parseCronHour(config.sync.sync_cron_expression) : '-'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Evaluation Configuration */}
      <div className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">{t('settings.evaluationConfig')}</h2>
        {configLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading')}...
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('settings.llmModel')}
              </label>
              <input
                type="text"
                disabled
                value={config?.evaluation.ragas_llm_model || '-'}
                className="w-full rounded-md border bg-secondary px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('results.embeddingModel')}
              </label>
              <input
                type="text"
                disabled
                value={config?.evaluation.ragas_embedding_model || '-'}
                className="w-full rounded-md border bg-secondary px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('settings.evaluationCron')}
              </label>
              <input
                type="text"
                disabled
                value={config?.evaluation.evaluation_cron_expression || '-'}
                className="w-full rounded-md border bg-secondary px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t('settings.runsDaily')} {config ? parseCronHour(config.evaluation.evaluation_cron_expression) : '-'}
              </p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('settings.batchSize')}
              </label>
              <input
                type="text"
                disabled
                value={config?.evaluation.evaluation_batch_size?.toString() || '-'}
                className="w-full rounded-md border bg-secondary px-3 py-2 text-sm"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
