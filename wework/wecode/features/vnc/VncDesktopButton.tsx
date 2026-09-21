import { Monitor } from 'lucide-react'

import { DeviceActionButton } from '@/components/settings/DeviceActionButton'
import type { DeviceSurfaceActionProps } from '@/extensions/device-surface-contract'
import { useTranslation } from '@/hooks/useTranslation'
import { useCloudDesktopLaunch } from './useCloudDesktopLaunch'

export function VncDesktopButton({ deviceId, disabled, onOpened }: DeviceSurfaceActionProps) {
  const { t } = useTranslation('vnc')
  const launch = useCloudDesktopLaunch({
    contextKey: `connection:${deviceId}`,
    deviceId,
    disabled,
    failureMessage: t('open_system_desktop_failed', '无法使用系统默认浏览器打开云桌面，请重试'),
    onOpened,
    target: 'system',
  })

  return (
    <div className="flex flex-col items-end gap-1">
      <DeviceActionButton
        testId={`connection-vnc-button-${deviceId}`}
        icon={Monitor}
        label={t('desktop', '桌面')}
        onClick={() => void launch.open()}
        disabled={launch.disabled}
      />
      {launch.error && (
        <p
          role="alert"
          data-testid={`connection-vnc-error-${deviceId}`}
          className="max-w-48 text-right text-xs text-red-500"
        >
          {launch.error}
        </p>
      )}
    </div>
  )
}
