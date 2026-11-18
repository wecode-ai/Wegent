import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useLayoutEffect, useState } from 'react'
import {
  registerMcpAppPanel,
  useMcpAppPanels,
  reconcileMcpAppWorkspacePanels,
  type McpAppPanel,
  type McpAppPanelTab,
} from './workspacePanels'

const address = { deviceId: 'device', taskId: 'task' }

function PanelTabs() {
  const current = useMcpAppPanels(address)
  const [previous, setPrevious] = useState<readonly McpAppPanel[]>([])
  const [state, setState] = useState<{
    tabs: McpAppPanelTab[]
    view: McpAppPanelTab | 'launcher'
  }>({ tabs: [], view: 'launcher' })
  if (previous !== current) {
    setPrevious(current)
    setState(reconcileMcpAppWorkspacePanels(previous, current, state.tabs, state.view))
  }
  return (
    <output data-testid="panel-tabs">
      {state.tabs.join(',')}:{state.view}
    </output>
  )
}

it('opens and removes registered tabs through the owning workbench', () => {
  const view = render(<PanelTabs />)
  let remove!: () => void
  act(() => {
    remove = registerMcpAppPanel({
      id: 'mcp-app:fixture',
      address,
      paneId: 'single',
      title: 'App',
      attach: () => () => {},
      dismiss: vi.fn(),
    })
  })
  expect(screen.getByTestId('panel-tabs')).toHaveTextContent('mcp-app:fixture:mcp-app:fixture')
  act(() => remove())
  expect(screen.getByTestId('panel-tabs')).toHaveTextContent(':launcher')
  view.unmount()
})

it('opens an app registered by a child layout effect', () => {
  function App({ expanded }: { expanded: boolean }) {
    useLayoutEffect(() => {
      if (!expanded) return
      return registerMcpAppPanel({
        id: 'mcp-app:layout',
        address,
        paneId: 'single',
        title: 'App',
        attach: () => () => {},
        dismiss: vi.fn(),
      })
    }, [expanded])
    return null
  }
  function Workbench({ expanded }: { expanded: boolean }) {
    return (
      <>
        <PanelTabs />
        <App expanded={expanded} />
      </>
    )
  }
  const view = render(<Workbench expanded={false} />)
  view.rerender(<Workbench expanded />)
  expect(screen.getByTestId('panel-tabs')).toHaveTextContent('mcp-app:layout:mcp-app:layout')
  view.unmount()
})
