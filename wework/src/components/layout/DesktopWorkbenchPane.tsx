import { recordUiRender } from '@/e2e/ui-refresh-capture'
import { memo } from 'react'
import { useDesktopWorkbenchPaneModel } from './useDesktopWorkbenchPaneModel'
import { DesktopWorkbenchPaneView } from './DesktopWorkbenchPaneView'
export const DesktopWorkbenchPane = memo(function DesktopWorkbenchPane(
  props: Parameters<typeof useDesktopWorkbenchPaneModel>[0]
) {
  recordUiRender('workbench-conversation')
  const model = useDesktopWorkbenchPaneModel(props)
  return <DesktopWorkbenchPaneView model={model} />
})
