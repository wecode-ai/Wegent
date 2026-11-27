import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { StandInExecutorApi } from '@/api/standIn'
import { createAccountStandInInstanceSource } from './standInAccountInstanceSource'
import { createLocalStandInInstanceSource } from './standInLocalInstanceSource'

export { hasSavedStandIn, initializeStandInTarget } from './standInLocalInstanceSource'
export {
  configuredPrimaryStandInDevice,
  getStandInAccountStopIntent,
  isLocalDesktopDeviceId,
  normalizeStandInBindingTarget,
  resolvePrimaryStandInDevice,
  resolveReachableStandInDevice,
} from './standInAccountInstanceSource'

/** Account settings own the shared execution choice; pre-account setup uses the local binding. */
export function createStandInInstanceSource(options: {
  services: WorkbenchServices
  api: StandInExecutorApi | undefined
  userId: number
  backendUrl: string
  accountMode?: boolean
  initialDeviceId?: string
  requireSetupConfirmation?: boolean
}) {
  return options.accountMode
    ? createAccountStandInInstanceSource(options)
    : createLocalStandInInstanceSource(options)
}
