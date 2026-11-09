import { Check, Cloud, Copy, Server } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { remoteDeviceOnboardingExtension } from '@extensions/remote-device-onboarding'
import {
  deviceOnboardingScope,
  useDeviceOnboarding,
  type DeviceOnboardingProps,
} from './useDeviceOnboarding'

export function AddDevicePanel(props: DeviceOnboardingProps) {
  return <DeviceOnboardingPanel key={deviceOnboardingScope(props.cloudConnection)} {...props} />
}

function DeviceOnboardingPanel(props: DeviceOnboardingProps) {
  const { t } = useTranslation('common')
  const { hasCloudDevice = false } = props
  const {
    loading,
    remoteLoading,
    error,
    remoteCommand,
    remoteStatus,
    copied,
    cloudCreated,
    disconnected,
    handleCreate,
    handleCreateRemoteDocker,
    handleCopyRemoteCommand,
    retryConnection,
  } = useDeviceOnboarding(props)

  return (
    <div data-testid="add-device-panel" className="space-y-3">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {disconnected && (
        <p role="alert" className="text-sm text-text-secondary">
          {t('workbench.cloud_connection_sidebar_disconnected')}
        </p>
      )}
      <div className="flex items-start gap-3 rounded-lg border border-border bg-background p-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background text-text-secondary">
          <Cloud className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-text-primary">
                {t('workbench.add_device_cloud_title')}
              </h3>
              <p className="mt-1 text-xs leading-5 text-text-secondary">
                {hasCloudDevice && !cloudCreated
                  ? t('workbench.add_device_cloud_limit_description')
                  : t('workbench.add_device_cloud_description')}
              </p>
            </div>
            <button
              type="button"
              data-testid="add-cloud-device-confirm"
              onClick={handleCreate}
              disabled={hasCloudDevice || cloudCreated || loading || remoteLoading || disconnected}
              className="h-8 shrink-0 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading || cloudCreated
                ? t('workbench.add_device_cloud_creating')
                : hasCloudDevice
                  ? t('workbench.add_device_cloud_created')
                  : t('workbench.add_device_cloud_create')}
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-border bg-background p-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background text-text-secondary">
          <Server className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-text-primary">
                {t('workbench.remote_docker_title')}
              </h3>
              <p className="mt-1 text-xs leading-5 text-text-secondary">
                {t('workbench.remote_docker_description')}
              </p>
            </div>
            <button
              type="button"
              data-testid="add-remote-docker-button"
              onClick={handleCreateRemoteDocker}
              disabled={loading || remoteLoading || cloudCreated || disconnected}
              className="h-8 shrink-0 rounded-md bg-surface px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {remoteLoading
                ? t('workbench.remote_docker_generating')
                : t('workbench.remote_docker_generate')}
            </button>
          </div>

          <remoteDeviceOnboardingExtension.Notice />

          {remoteCommand && (
            <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background">
              <div className="flex h-8 items-center justify-between border-b border-border px-3">
                <span className="text-xs font-semibold text-text-secondary">
                  {t('workbench.remote_docker_command_title')}
                </span>
                <button
                  type="button"
                  data-testid="copy-remote-docker-command"
                  onClick={handleCopyRemoteCommand}
                  className="inline-flex h-6 items-center gap-1 rounded px-2 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? t('workbench.remote_docker_copied') : t('workbench.remote_docker_copy')}
                </button>
              </div>
              <pre
                data-testid="remote-docker-command"
                className="max-h-[220px] overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-code text-text-primary"
              >
                {remoteCommand.command}
              </pre>
              <remoteDeviceOnboardingExtension.CommandDetails
                command={remoteCommand}
                status={remoteStatus}
              />
            </div>
          )}
        </div>
      </div>
      {(remoteCommand || cloudCreated) && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 text-sm text-text-secondary"
        >
          <span data-testid="device-onboarding-status">
            {t(`workbench.device_onboarding_${remoteStatus}`)}
          </span>
          {(remoteStatus === 'connection_failed' || remoteStatus === 'version_mismatch') && (
            <button
              type="button"
              data-testid="retry-device-onboarding"
              onClick={retryConnection}
              className="h-8 shrink-0 rounded-md px-3 hover:bg-muted"
            >
              {t('workbench.connection_upgrade_refresh')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
