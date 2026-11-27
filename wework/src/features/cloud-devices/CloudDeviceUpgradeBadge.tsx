import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/api'
import { Button } from '@wegent/collaboration/markdown/Button'
import { cloudUpgradeReminder } from './cloudDeviceUpgradeReminder'
import { useWorkbenchCloudDeviceRestarts } from './useWorkbenchCloudDeviceRestarts'

export function CloudDeviceUpgradeBadge({
  device,
  actionable,
}: {
  device?: DeviceInfo | null
  actionable?: boolean
}) {
  const { t } = useTranslation('common')
  const restarts = useWorkbenchCloudDeviceRestarts()
  if (!device || !cloudUpgradeReminder(device)) return null
  if (actionable && restarts) {
    return (
      <Button
        type="button"
        variant="unstyled"
        data-testid="cloud-device-upgrade-action"
        className="h-7 shrink-0 rounded px-1 text-xs text-warning hover:bg-muted"
        disabled={restarts.isRestarting(device)}
        onClick={() => restarts.requestRestart([device], true)}
      >
        {t('workbench.cloud_upgrade_badge')}
      </Button>
    )
  }
  return (
    <span data-testid="cloud-device-upgrade-badge" className="shrink-0 text-xs text-warning">
      {t('workbench.cloud_upgrade_badge')}
    </span>
  )
}
