import { AlertCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { getWorkbenchDeviceUnavailableDisplayName } from '@/lib/workbench-device'
import { cn } from '@/lib/utils'
import type { DeviceInfo } from '@/types/api'

interface ConversationDeviceOfflineBannerProps {
  device: DeviceInfo | null
  deviceId?: string | null
  className?: string
}

export function ConversationDeviceOfflineBanner({
  device,
  deviceId,
  className,
}: ConversationDeviceOfflineBannerProps) {
  const { t } = useTranslation('common')

  if (!deviceId || device?.status === 'online') return null

  const deviceName =
    getWorkbenchDeviceUnavailableDisplayName(device) || t('workbench.current_device', '当前设备')
  const message = device
    ? t('workbench.conversation_device_offline_notice', { device: deviceName })
    : t('workbench.conversation_device_unavailable_notice', { device: deviceName })

  return (
    <div
      data-testid="conversation-device-offline-banner"
      className={cn(
        'flex items-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-2 text-xs text-text-secondary shadow-sm backdrop-blur',
        className
      )}
    >
      <AlertCircle className="h-3.5 w-3.5 shrink-0 text-text-muted" />
      <span className="min-w-0 truncate">{message}</span>
    </div>
  )
}
