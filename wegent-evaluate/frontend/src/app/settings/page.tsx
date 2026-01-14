'use client'

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { triggerSync, getSyncStatus } from '@/apis/sync'
import { triggerEvaluation, getEvaluationStatus } from '@/apis/evaluation'
import { getSettingsConfig, SettingsConfig } from '@/apis/settings'
import { generateWeeklyReport } from '@/apis/report'
import { useVersion } from '@/contexts/VersionContext'
import { Loader2, FileText, AlertTriangle, Copy, Check } from 'lucide-react'
import type { SyncTriggerRequest, WeeklyReportResponse, DataVersion } from '@/types'

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
  const { versions, currentVersion, refreshVersions } = useVersion()

  // Settings config state
  const [config, setConfig] = useState<SettingsConfig | null>(null)
  const [configLoading, setConfigLoading] = useState(true)

  // Sync state
  const [syncStartDate, setSyncStartDate] = useState('')
  const [syncEndDate, setSyncEndDate] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Version selection for sync
  const [versionMode, setVersionMode] = useState<'new' | 'existing'>('new')
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null)
  const [writeMode, setWriteMode] = useState<'append' | 'replace'>('append')
  const [versionDescription, setVersionDescription] = useState('')

  // Evaluation state
  const [evalStartId, setEvalStartId] = useState('')
  const [evalEndId, setEvalEndId] = useState('')
  const [forceEval, setForceEval] = useState(false)
  const [evaluating, setEvaluating] = useState(false)
  const [evalMessage, setEvalMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Report state
  const [reportVersionId, setReportVersionId] = useState<number | null>(null)
  const [generating, setGenerating] = useState(false)
  const [reportResult, setReportResult] = useState<WeeklyReportResponse | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

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

  // Set default version selection
  useEffect(() => {
    if (versions.length > 0 && selectedVersionId === null) {
      setSelectedVersionId(versions[0].id)
    }
    if (versions.length > 0 && reportVersionId === null) {
      setReportVersionId(versions[0].id)
    }
  }, [versions, selectedVersionId, reportVersionId])

  // Handle sync trigger
  const handleTriggerSync = async () => {
    if (!syncStartDate || !syncEndDate) {
      setSyncMessage({ type: 'error', text: t('version.error_select_dates', 'Please select both start and end dates') })
      return
    }

    if (versionMode === 'existing' && !selectedVersionId) {
      setSyncMessage({ type: 'error', text: t('version.error_select_version', 'Please select a version') })
      return
    }

    setSyncing(true)
    setSyncMessage(null)

    try {
      const params: SyncTriggerRequest = {
        start_time: formatDateTime(syncStartDate),
        end_time: formatDateTime(syncEndDate),
        version_mode: versionMode,
      }

      if (versionMode === 'new') {
        if (versionDescription) {
          params.version_description = versionDescription
        }
      } else {
        params.version_id = selectedVersionId!
        params.write_mode = writeMode
      }

      const result = await triggerSync(params)

      // Poll for completion
      const pollStatus = async () => {
        try {
          const statusResult = await getSyncStatus(result.sync_id)
          if (statusResult.status === 'completed') {
            setSyncing(false)
            setSyncMessage({
              type: 'success',
              text: `${t('version.sync_completed', 'Sync completed!')} ${statusResult.total_inserted || 0} ${t('version.records_synced', 'records synced.')}`,
            })
            // Refresh versions to update sync counts
            refreshVersions()
          } else if (statusResult.status === 'failed') {
            setSyncing(false)
            setSyncMessage({
              type: 'error',
              text: `${t('version.sync_failed', 'Sync failed:')} ${statusResult.error_message || 'Unknown error'}`,
            })
          } else {
            setTimeout(pollStatus, 2000)
          }
        } catch {
          setSyncing(false)
          setSyncMessage({ type: 'error', text: t('version.error_check_status', 'Failed to check sync status') })
        }
      }
      pollStatus()
    } catch (err) {
      setSyncing(false)
      setSyncMessage({
        type: 'error',
        text: err instanceof Error ? err.message : t('version.error_trigger_sync', 'Failed to trigger sync'),
      })
    }
  }

  // Handle evaluation trigger
  const handleTriggerEvaluation = async () => {
    if (!evalStartId || !evalEndId) {
      setEvalMessage({ type: 'error', text: t('settings.error_enter_ids', 'Please enter both start and end IDs') })
      return
    }

    const startId = parseInt(evalStartId)
    const endId = parseInt(evalEndId)

    if (isNaN(startId) || isNaN(endId)) {
      setEvalMessage({ type: 'error', text: t('settings.error_invalid_id', 'Invalid ID format') })
      return
    }

    if (startId > endId) {
      setEvalMessage({ type: 'error', text: t('settings.error_id_order', 'Start ID must be less than or equal to End ID') })
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
              text: `${t('settings.eval_completed', 'Evaluation completed!')} ${statusResult.completed || 0} ${t('settings.records_evaluated', 'records evaluated.')}`,
            })
          } else if (statusResult.status === 'failed') {
            setEvaluating(false)
            setEvalMessage({
              type: 'error',
              text: `${t('settings.eval_failed', 'Evaluation failed:')} ${statusResult.error || 'Unknown error'}`,
            })
          } else {
            setTimeout(pollStatus, 2000)
          }
        } catch {
          setEvaluating(false)
          setEvalMessage({ type: 'error', text: t('settings.error_check_eval_status', 'Failed to check evaluation status') })
        }
      }
      pollStatus()
    } catch (err) {
      setEvaluating(false)
      setEvalMessage({
        type: 'error',
        text: err instanceof Error ? err.message : t('settings.error_trigger_eval', 'Failed to trigger evaluation'),
      })
    }
  }

  // Handle report generation
  const handleGenerateReport = async () => {
    if (!reportVersionId) {
      setReportError(t('report.error_select_version', 'Please select a version'))
      return
    }

    setGenerating(true)
    setReportError(null)
    setReportResult(null)

    try {
      const result = await generateWeeklyReport({ version_id: reportVersionId })
      setReportResult(result)
    } catch (err) {
      setReportError(err instanceof Error ? err.message : t('report.error_generate', 'Failed to generate report'))
    } finally {
      setGenerating(false)
    }
  }

  // Handle copy to clipboard
  const handleCopyReport = async () => {
    if (!reportResult) return

    try {
      await navigator.clipboard.writeText(reportResult.markdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
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

        {/* Time range */}
        <div className="flex flex-wrap gap-4 mb-4">
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
        </div>

        {/* Version selection */}
        <div className="border-t pt-4 mt-4">
          <h3 className="text-sm font-medium mb-3">{t('version.title', 'Version Selection')}</h3>

          <div className="space-y-3">
            {/* New version option */}
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="versionMode"
                value="new"
                checked={versionMode === 'new'}
                onChange={() => setVersionMode('new')}
                className="mt-1"
              />
              <div className="flex-1">
                <span className="text-sm font-medium">{t('version.create_new', 'Create New Version')}</span>
                {versionMode === 'new' && (
                  <div className="mt-2">
                    <input
                      type="text"
                      value={versionDescription}
                      onChange={(e) => setVersionDescription(e.target.value)}
                      placeholder={t('version.description_placeholder', 'Version description (optional)')}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    />
                  </div>
                )}
              </div>
            </label>

            {/* Existing version option */}
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="versionMode"
                value="existing"
                checked={versionMode === 'existing'}
                onChange={() => setVersionMode('existing')}
                className="mt-1"
              />
              <div className="flex-1">
                <span className="text-sm font-medium">{t('version.use_existing', 'Use Existing Version')}</span>
                {versionMode === 'existing' && (
                  <div className="mt-2 space-y-3">
                    <select
                      value={selectedVersionId || ''}
                      onChange={(e) => setSelectedVersionId(Number(e.target.value))}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    >
                      {versions.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} - {new Date(v.created_at).toLocaleDateString()} ({v.sync_count}{t('version.sync_count_unit', '条')})
                        </option>
                      ))}
                    </select>

                    <div className="space-y-2">
                      <span className="text-sm text-muted-foreground">{t('version.write_mode', 'Write Mode')}:</span>
                      <div className="flex gap-4">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name="writeMode"
                            value="append"
                            checked={writeMode === 'append'}
                            onChange={() => setWriteMode('append')}
                          />
                          <div>
                            <span className="text-sm">{t('version.append', 'Append')}</span>
                            <p className="text-xs text-muted-foreground">{t('version.append_desc', 'Keep existing data, add new sync data')}</p>
                          </div>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name="writeMode"
                            value="replace"
                            checked={writeMode === 'replace'}
                            onChange={() => setWriteMode('replace')}
                          />
                          <div>
                            <span className="text-sm">{t('version.replace', 'Replace')}</span>
                            <p className="text-xs text-muted-foreground">{t('version.replace_desc', 'Clear existing data, write new sync data')}</p>
                          </div>
                        </label>
                      </div>
                      {writeMode === 'replace' && (
                        <div className="flex items-start gap-2 p-2 bg-yellow-50 border border-yellow-200 rounded-md text-xs text-yellow-800">
                          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                          <span>{t('version.replace_warning', 'Replace will delete all existing data and evaluation results for this version')}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </label>
          </div>
        </div>

        <div className="mt-4">
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

      {/* Weekly Report */}
      <div className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">{t('report.title', 'Weekly Report')}</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {t('report.description', 'Generate a weekly evaluation report for the selected version.')}
        </p>

        <div className="flex items-center gap-4 mb-4">
          <div className="flex items-center gap-2">
            <label className="text-sm">{t('report.select_version', 'Select Version')}:</label>
            <select
              value={reportVersionId || ''}
              onChange={(e) => setReportVersionId(Number(e.target.value))}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} - {new Date(v.created_at).toLocaleDateString()} ({v.sync_count}{t('version.sync_count_unit', '条')})
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={handleGenerateReport}
            disabled={generating}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {generating && <Loader2 className="h-4 w-4 animate-spin" />}
            <FileText className="h-4 w-4" />
            {t('report.generate', 'Generate Report')}
          </button>
        </div>

        {reportError && (
          <div className="rounded-md p-3 text-sm bg-red-50 text-red-700 border border-red-200 mb-4">
            {reportError}
          </div>
        )}

        {reportResult && (
          <div className="border rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium">
                {t('report.preview', 'Report Preview')} - {reportResult.version_name}
              </h3>
              <button
                onClick={handleCopyReport}
                className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-secondary"
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4 text-green-600" />
                    {t('report.copied', 'Copied!')}
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    {t('report.copy_to_clipboard', 'Copy to Clipboard')}
                  </>
                )}
              </button>
            </div>
            <div className="max-h-96 overflow-y-auto bg-secondary/50 rounded-md p-4">
              <pre className="text-xs whitespace-pre-wrap font-mono">{reportResult.markdown}</pre>
            </div>
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
