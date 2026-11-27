import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/api'
import { Button } from '@wegent/collaboration/markdown/Button'
import { ArrowUpCircle } from 'lucide-react'
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
  const reminder = cloudUpgradeReminder(device)
  if (!device || !reminder) return null

  if (actionable && restarts) {
    const restartLabel = t('workbench.connection_restart_version_tooltip', {
      current: device.executor_version ?? '',
      latest: reminder.target_version,
    })

    return (
      <Tooltip label={restartLabel}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="cloud-device-upgrade-action"
          aria-label={restartLabel}
          className="shrink-0 gap-1 px-2 text-xs md:min-h-7"
          disabled={restarts.isRestarting(device)}
          onClick={() => restarts.requestRestart([device], true)}
        >
          <ArrowUpCircle aria-hidden="true" className="text-warning" />
          {t('workbench.connection_update_available')}
        </Button>
      </Tooltip>
    )
  }

  const label = t('workbench.cloud_upgrade_badge')
  return (
    <Tooltip label={label}>
      <span
        role="img"
        aria-label={label}
        data-testid="cloud-device-upgrade-badge"
        className="inline-flex shrink-0 items-center text-warning"
      >
        <ArrowUpCircle aria-hidden="true" className="h-3.5 w-3.5" />
      </span>
    </Tooltip>
  )
}
