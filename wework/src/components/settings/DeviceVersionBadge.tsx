import { ArrowUpCircle } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/devices'

function formatDeviceVersion(version?: string | null): string {
  if (!version) return '-'
  return /^v/i.test(version) ? version : `v${version}`
}

export function DeviceVersionBadge({
  device,
  disabled,
  onUpgrade,
}: {
  device: DeviceInfo
  disabled: boolean
  onUpgrade: () => void
}) {
  const { t } = useTranslation('common')
  const currentVersion = formatDeviceVersion(device.executor_version)
  const latestVersion = formatDeviceVersion(device.latest_version)
  const updateLabel = t('workbench.connection_upgrade_version_tooltip', {
    current: currentVersion,
    latest: latestVersion,
  })

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-text-secondary">
        {currentVersion}
      </span>
      {device.update_available === true ? (
        <Tooltip
          label={updateLabel}
          side="bottom"
          testId={`connection-upgrade-tooltip-${device.device_id}`}
        >
          <button
            type="button"
            data-testid={`connection-upgrade-badge-${device.device_id}`}
            aria-label={updateLabel}
            onClick={onUpgrade}
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 disabled:cursor-not-allowed disabled:opacity-50 dark:text-blue-400"
          >
            <ArrowUpCircle className="h-3 w-3" aria-hidden="true" />
            {t('workbench.connection_upgrade_available')}
          </button>
        </Tooltip>
      ) : null}
    </div>
  )
}
