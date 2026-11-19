import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/devices'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ArrowUpCircle } from 'lucide-react'

function formatDeviceVersion(version?: string | null): string {
  if (!version) return '-'
  return /^v/i.test(version) ? version : `v${version}`
}

export function DeviceVersionBadge({
  device,
  disabled,
  onRestart,
}: {
  device: DeviceInfo
  disabled: boolean
  onRestart: () => void
}) {
  const { t } = useTranslation('common')
  const currentVersion = formatDeviceVersion(device.executor_version)
  const latestVersion = formatDeviceVersion(device.latest_version)
  const isRemote = device.device_type === 'remote'
  const updateLabel = t('workbench.connection_restart_version_tooltip', {
    current: currentVersion,
    latest: latestVersion,
  })

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-text-secondary">
        {currentVersion}
      </span>
      {device.update_available === true && !isRemote ? (
        <Tooltip
          label={updateLabel}
          side="bottom"
          testId={`connection-upgrade-tooltip-${device.device_id}`}
        >
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={`connection-upgrade-badge-${device.device_id}`}
            aria-label={updateLabel}
            onClick={onRestart}
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded-full bg-focus/10 px-2 py-0.5 text-xs font-medium text-focus hover:bg-focus/15 focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/60 disabled:cursor-not-allowed disabled:opacity-50 wework:bg-blue-500/10 wework:text-blue-600 wework:hover:bg-blue-500/15 wework:keyboard:focus-visible:ring-blue-500/60 wework:dark:text-blue-400"
          >
            <ArrowUpCircle className="h-3 w-3" aria-hidden="true" />
            {t('workbench.connection_update_available')}
          </ControlButton>
        </Tooltip>
      ) : null}
    </div>
  )
}
