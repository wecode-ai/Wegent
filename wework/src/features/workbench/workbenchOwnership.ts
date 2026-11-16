import type { User } from '@/types/api'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'

type WorkbenchConnection = Pick<
  CloudConnectionContextValue,
  'isConnected' | 'serviceKey' | 'apiBaseUrl' | 'user'
>

export function workbenchOwnershipKey(
  connection: WorkbenchConnection,
  user: Pick<User, 'id'> | null | undefined
): string {
  return JSON.stringify([connection.isConnected ? (connection.apiBaseUrl ?? '') : '', user?.id])
}

/** The mounted owner must use the same local or cloud boundary as its services. */
export function resolveWorkbenchOwnership<T extends User | null | undefined>(
  connection: WorkbenchConnection,
  localUser: T
): { user: User | T; key: string } {
  const user: User | T =
    connection.isConnected && !connection.serviceKey.startsWith('fallback:') && connection.user
      ? connection.user
      : localUser
  return { user, key: workbenchOwnershipKey(connection, user) }
}
