import { useTranslation } from '@/hooks/useTranslation'
import type { RemoteDeviceCommandDetailsProps } from '@/extensions/remote-device-onboarding-contract'

export function RemoteDeviceOnboardingNotice() {
  const { t } = useTranslation('remoteDevice')

  return (
    <div className="mt-3 rounded-md bg-surface px-3 py-2 text-xs leading-5 text-text-secondary">
      {t('network_notice')}
    </div>
  )
}

export function RemoteDeviceCommandDetails({ command, status }: RemoteDeviceCommandDetailsProps) {
  const { t } = useTranslation('remoteDevice')

  return (
    <div className="border-t border-border px-3 py-2 text-xs text-text-secondary">
      <div data-testid="remote-docker-image">
        {t('image_label')}: {command.image}
      </div>
      <div data-testid="remote-docker-backend-url" className="mt-1">
        {t('backend_url_label')}: {command.env.WEGENT_BACKEND_URL}
      </div>
      <div data-testid="remote-docker-socket-url" className="mt-1">
        {t('socket_url_label')}: {command.env.WEGENT_SOCKET_URL}
      </div>
      <div data-testid="remote-docker-connection-status" className="mt-1">
        {t(`status_${status}`)}
      </div>
    </div>
  )
}
