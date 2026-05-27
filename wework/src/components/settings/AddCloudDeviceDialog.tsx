import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { createHttpClient } from '@/api/http'
import { createDeviceApi } from '@/api/devices'
import { getRuntimeConfig } from '@/config/runtime'

interface AddCloudDeviceDialogProps {
  open: boolean
  onClose: () => void
  onCreated: () => void
}

export function AddCloudDeviceDialog({ open, onClose, onCreated }: AddCloudDeviceDialogProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  const handleCreate = async () => {
    setLoading(true)
    setError(null)
    try {
      const { apiBaseUrl } = getRuntimeConfig()
      const client = createHttpClient({ baseUrl: apiBaseUrl })
      const deviceApi = createDeviceApi(client)
      await deviceApi.createCloudDevice()
      onCreated()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create cloud device')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        data-testid="add-cloud-device-dialog"
        className="w-[400px] rounded-lg border border-[#e2e2e2] bg-white p-6 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-[#2d2d2d]">添加云设备</h2>
          <button
            type="button"
            data-testid="add-cloud-device-close"
            onClick={onClose}
            className="rounded p-1 text-[#6b6f76] hover:bg-[#f5f5f5]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-4 text-sm text-[#6b6f76]">
          将创建一台新的云设备，设备初始化约需 2-3 分钟。
        </p>

        {error && (
          <div className="mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-600">
            {error}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            data-testid="add-cloud-device-cancel"
            onClick={onClose}
            disabled={loading}
            className="h-8 rounded-md border border-[#dedede] px-4 text-sm text-[#3c4043] hover:bg-[#f7f7f8] disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="add-cloud-device-confirm"
            onClick={handleCreate}
            disabled={loading}
            className="h-8 rounded-md bg-[#14B8A6] px-4 text-sm font-medium text-white hover:bg-[#0d9488] disabled:opacity-50"
          >
            {loading ? '创建中...' : '确认创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
