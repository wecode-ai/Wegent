import type { ExecutorClient } from '@/api/executorAccess'
import type { User } from '@/types/api'
import type { WorkbenchSessionState } from './workbenchSessionState'
import type { WorkbenchServices } from './workbenchServices'

export interface WorkbenchDataRefreshOptions {
  user: User
  ownershipKey?: string
  stateSource: Pick<WorkbenchSessionState, 'getSnapshot' | 'dispatch'>
  executorClient: ExecutorClient
  services: WorkbenchServices
  canNavigate?: () => boolean
}
