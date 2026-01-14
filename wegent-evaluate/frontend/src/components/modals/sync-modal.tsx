'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Loader2 } from 'lucide-react'
import { triggerSync, getSyncStatus } from '@/apis/sync'

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

interface SyncModalProps {
  open: boolean
  onClose: () => void
  onSuccess?: () => void
}

export function SyncModal({ open, onClose, onSuccess }: SyncModalProps) {
  const { t } = useTranslation()
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!startDate || !endDate) return

    setLoading(true)
    setError(null)
    setStatus(null)

    try {
      const result = await triggerSync({
        start_time: formatDateTime(startDate),
        end_time: formatDateTime(endDate),
        version_mode: 'new',  // Default to create new version for simple modal
      })

      setStatus(`Sync started: ${result.sync_id}`)

      // Poll for status
      const pollStatus = async () => {
        try {
          const statusResult = await getSyncStatus(result.sync_id)
          setStatus(
            `Status: ${statusResult.status} | Fetched: ${statusResult.total_fetched} | Inserted: ${statusResult.total_inserted}`
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
      setError(err instanceof Error ? err.message : 'Failed to trigger sync')
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-card p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('dashboard.triggerSync')}</h2>
          <button
            onClick={onClose}
            className="rounded-full p-1 hover:bg-secondary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">
              {t('results.dateRange')} - Start
            </label>
            <input
              type="datetime-local"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              {t('results.dateRange')} - End
            </label>
            <input
              type="datetime-local"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              required
            />
          </div>

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
