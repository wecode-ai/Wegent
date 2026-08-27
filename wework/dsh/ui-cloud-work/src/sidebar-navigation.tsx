import type { WeworkDshSidebarNavigationModuleProps } from '@/features/dsh-runtime/dshSidebarNavigation'
import { isCloudConnectionUiAvailable } from '@/features/cloud-connection/cloudConnectionAvailability'
import { CloudConnectionSidebarButton } from './CloudConnectionSidebarButton'

export default function CloudWorkSidebarNavigation({
  cloudWorkStatus,
  devices,
  item,
  onAddRemoteDevice,
  onNavigate,
  onOpenSettings,
  onSelectStandaloneDevice,
  selected,
}: WeworkDshSidebarNavigationModuleProps) {
  if (!isCloudConnectionUiAvailable()) return null
  return (
    <CloudConnectionSidebarButton
      devices={devices}
      cloudWorkStatus={cloudWorkStatus}
      selected={selected}
      onOpenCloudWork={() => onNavigate(item.path)}
      onOpenSettings={() => onOpenSettings('connections')}
      onSelectCloudDevice={deviceId => onSelectStandaloneDevice?.(deviceId)}
      onAddDevice={onAddRemoteDevice}
    />
  )
}
