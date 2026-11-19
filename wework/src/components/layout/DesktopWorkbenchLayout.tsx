import { useDesktopWorkbenchLayoutModel } from './useDesktopWorkbenchLayoutModel'
import { DesktopWorkbenchLayoutView } from './DesktopWorkbenchLayoutView'
import type { DesktopWorkbenchLayoutProps } from './desktopWorkbenchLayoutHelpers'
export function DesktopWorkbenchLayout(props: DesktopWorkbenchLayoutProps) {
  const model = useDesktopWorkbenchLayoutModel(props)
  return <DesktopWorkbenchLayoutView model={model} />
}
