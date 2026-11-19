import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { OwnedWorkbenchProvider } from './OwnedWorkbenchProvider'
import { resolveWorkbenchOwnership } from './workbenchOwnership'
import type { WorkbenchProviderProps } from './workbenchContextTypes'
export type { WorkbenchServices } from './workbenchServices'
export function WorkbenchProvider(props: WorkbenchProviderProps) {
  const connection = useOptionalCloudConnection()
  const { user: workbenchIdentity, key: ownershipKey } = resolveWorkbenchOwnership(
    connection,
    props.user
  )
  return (
    <OwnedWorkbenchProvider
      key={ownershipKey}
      {...props}
      workbenchIdentity={workbenchIdentity}
      ownershipKey={ownershipKey}
    />
  )
}
