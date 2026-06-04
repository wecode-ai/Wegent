import { Cloud, X } from 'lucide-react'
import { useCallback, useState } from 'react'
import { createHttpClient } from '@/api/http'
import { createDeviceApi } from '@/api/devices'
import { getRuntimeConfig } from '@/config/runtime'

interface AddCloudDeviceDialogProps {
  open: boolean
  onClose: () => void
  onCreated: () => void
  onCreatingChange?: (creating: boolean) => void
}

export function AddCloudDeviceDialog({
  open,
  onClose,
  onCreated,
  onCreatingChange,
}: AddCloudDeviceDialogProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { apiBaseUrl } = getRuntimeConfig()
      const client = createHttpClient({ baseUrl: apiBaseUrl })
      const deviceApi = createDeviceApi(client)
      await deviceApi.createCloudDevice()
      onCreatingChange?.(true)
      onClose()
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败，请重试')
      onCreatingChange?.(false)
    } finally {
      setLoading(false)
    }
  }, [onClose, onCreated, onCreatingChange])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35"
      onClick={e => {
        if (!loading && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        data-testid="add-cloud-device-dialog"
        className="w-[420px] rounded-lg border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Cloud className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-text-primary">添加云设备</h2>
            <p className="mt-1.5 text-xs leading-5 text-text-secondary">
              将创建一台新的云设备，设备初始化约需 2-3 分钟。
            </p>
          </div>
          <button
            type="button"
            data-testid="add-cloud-device-close"
            onClick={onClose}
            disabled={loading}
            className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-text-muted hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="add-cloud-device-cancel"
            onClick={onClose}
            disabled={loading}
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="add-cloud-device-confirm"
            onClick={handleCreate}
            disabled={loading}
            className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-contrast hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? '创建中...' : '确认创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
