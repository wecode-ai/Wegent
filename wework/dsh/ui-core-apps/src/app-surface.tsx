import { WorkbenchPage } from '@/pages/WorkbenchPage'
import type { WeworkDshAppModuleProps } from '@/features/dsh-runtime/DshAppSurface'

export default function CoreAppSurface({ active, app }: WeworkDshAppModuleProps) {
  const surfaceKind = app.workspaceKinds?.[0]
  if (!surfaceKind) return null
  return <WorkbenchPage routeActive={active} surfaceKind={surfaceKind} />
}
