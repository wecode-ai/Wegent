import { act, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useLayoutEffect, useState } from 'react'
import { registerMcpAppPanel, useMcpAppWorkspacePanels } from './workspacePanels'

it('opens and removes registered tabs through the owning workbench', () => {
  const openTab = vi.fn()
  const closeTab = vi.fn()
  const address = { deviceId: 'device', taskId: 'task' }
  function Workbench() {
    useMcpAppWorkspacePanels({ address, openTab, closeTab })
    return null
  }
  const view = render(<Workbench />)
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
  expect(openTab).toHaveBeenCalledExactlyOnceWith('mcp-app:fixture')
  act(() => remove())
  expect(closeTab).toHaveBeenCalledExactlyOnceWith('mcp-app:fixture')
  view.unmount()
})

it('opens an app registered by a child layout effect', () => {
  const openTab = vi.fn()
  function App({ expanded }: { expanded: boolean }) {
    useLayoutEffect(() => {
      if (!expanded) return
      return registerMcpAppPanel({
        id: 'mcp-app:layout',
        address: { deviceId: 'device', taskId: 'task' },
        paneId: 'single',
        title: 'App',
        attach: () => () => {},
        dismiss: vi.fn(),
      })
    }, [expanded])
    return null
  }
  function Workbench({ expanded }: { expanded: boolean }) {
    const [, setTab] = useState('')
    useMcpAppWorkspacePanels({
      address: { deviceId: 'device', taskId: 'task' },
      openTab: tab => {
        openTab(tab)
        setTab(tab)
      },
      closeTab: vi.fn(),
    })
    return <App expanded={expanded} />
  }
  const view = render(<Workbench expanded={false} />)
  view.rerender(<Workbench expanded />)
  expect(openTab).toHaveBeenCalledExactlyOnceWith('mcp-app:layout')
  view.unmount()
})
