import type { StandInBindingTarget } from '@/api/standIn'
import { Button } from '@/components/ui/button'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/api'
import type { CollaborationProject } from '@wegent/collaboration'
import { StandInOnboarding } from './StandInOnboarding'
import { usePersonalStandIn } from './usePersonalStandIn'

/** Read the setup draft before the user's confirmation starts the unbound assistant. */
export function StandInActivation({
  services,
  target,
  localDeviceId,
  projects,
  devices,
  error,
  busy,
  active,
  onActivate,
  onOpenConversation,
  onClose,
}: {
  services: WorkbenchServices
  target: StandInBindingTarget
  localDeviceId: string
  projects: CollaborationProject[]
  devices: DeviceInfo[]
  error: string | null
  busy: boolean
  active: boolean
  onActivate(): Promise<boolean>
  onOpenConversation(): void
  onClose(): void
}) {
  const { t } = useTranslation('common')
  const settings = usePersonalStandIn(services, target.userId, target.deviceId, localDeviceId, {
    active,
  })
  const api = services.standInApi
  if (!api) return null
  return (
    <StandInOnboarding
      api={api}
      userId={target.userId}
      deviceId={target.deviceId}
      active={active}
      onActivate={onActivate}
      onOpenConversation={onOpenConversation}
      onClose={onClose}
      configuration={{
        settings: settings.saved,
        loading: settings.loading,
        error: settings.error ?? error,
        projects,
        localDeviceId,
        devices,
        services,
        onSave: settings.save,
        onReload: settings.reload,
      }}
    >
      <section className="space-y-3 p-5" data-testid="stand-in-instance-unbound">
        <h1 className="text-heading-sm font-medium">{t('personalHome.setupTitle')}</h1>
        <p className="text-sm text-text-secondary">{t('personalHome.setupHelp')}</p>
        <Button
          type="button"
          className="max-md:min-h-11"
          disabled={busy}
          data-testid="stand-in-instance-setup"
          onClick={() => void onActivate()}
        >
          {t('personalHome.setupAction')}
        </Button>
      </section>
    </StandInOnboarding>
  )
}
