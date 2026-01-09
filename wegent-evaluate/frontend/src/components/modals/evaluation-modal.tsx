'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Loader2 } from 'lucide-react'
import { triggerEvaluation, getEvaluationStatus } from '@/apis/evaluation'

interface EvaluationModalProps {
  open: boolean
  onClose: () => void
  onSuccess?: () => void
}

export function EvaluationModal({ open, onClose, onSuccess }: EvaluationModalProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'range' | 'ids'>('range')
  const [startId, setStartId] = useState('')
  const [endId, setEndId] = useState('')
  const [recordIds, setRecordIds] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setStatus(null)

    try {
      let result
      if (mode === 'range') {
        if (!startId || !endId) {
          throw new Error('Start ID and End ID are required')
        }
        result = await triggerEvaluation('range', {
          start_id: parseInt(startId),
          end_id: parseInt(endId),
        })
      } else {
        if (!recordIds) {
          throw new Error('Record IDs are required')
        }
        const ids = recordIds.split(',').map((id) => parseInt(id.trim()))
        result = await triggerEvaluation('ids', { record_ids: ids })
      }

      setStatus(`Evaluation started: ${result.job_id} (${result.total_records} records)`)

      // Poll for status
      const pollStatus = async () => {
        try {
          const statusResult = await getEvaluationStatus(result.job_id)
          setStatus(
            `Status: ${statusResult.status} | Completed: ${statusResult.completed}/${statusResult.total} | Failed: ${statusResult.failed}`
          )
          if (
            statusResult.status === 'completed' ||
            statusResult.status === 'failed'
          ) {
            setLoading(false)
            if (statusResult.status === 'completed') {
              onSuccess?.()
            }
          } else {
            setTimeout(pollStatus, 2000)
          }
        } catch {
          setLoading(false)
        }
      }
      pollStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger evaluation')
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-card p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('dashboard.triggerEvaluation')}</h2>
          <button
            onClick={onClose}
            className="rounded-full p-1 hover:bg-secondary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Mode</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'range' | 'ids')}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="range">ID Range</option>
              <option value="ids">Specific IDs</option>
            </select>
          </div>

          {mode === 'range' ? (
            <>
              <div>
                <label className="mb-1 block text-sm font-medium">Start ID</label>
                <input
                  type="number"
                  value={startId}
                  onChange={(e) => setStartId(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="1"
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">End ID</label>
                <input
                  type="number"
                  value={endId}
                  onChange={(e) => setEndId(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="100"
                  required
                />
              </div>
            </>
          ) : (
            <div>
              <label className="mb-1 block text-sm font-medium">Record IDs</label>
              <input
                type="text"
                value={recordIds}
                onChange={(e) => setRecordIds(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="1, 2, 3, 4"
                required
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Comma-separated list of record IDs
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {status && (
            <div className="rounded-md bg-blue-50 p-3 text-sm text-blue-700">
              {status}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border px-4 py-2 text-sm hover:bg-secondary"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('common.confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
