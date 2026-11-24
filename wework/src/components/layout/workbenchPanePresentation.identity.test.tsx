import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { expect, test } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import { SingleWorkbenchPane } from './workbenchPanePresentation'
import { getWorkbenchPaneKey, type WorkbenchPaneIdentity } from './workbenchPaneIdentity'
import { SplitWorkbenchPaneStack } from './workbenchPaneStack'
import { createWorkbenchLayout } from './workbenchSplitLayout'
import { WORKBENCH_SPLIT_ACTIONS_PORTAL_ID } from '@/components/topnav/TitlebarActionsPortal'

function Content() {
  const [open, setOpen] = useState(false)
  return <button onClick={() => setOpen(!open)}>{open ? 'Picker open' : 'Picker closed'}</button>
}
const renderPane = () => <Content />
const pane = (deviceId: string): WorkbenchPaneIdentity => ({
  currentProject: null,
  currentRuntimeTask: { deviceId, taskId: 'same-task' },
})
const devices: DeviceInfo[] = [
  {
    id: 79,
    device_id: 'electron-local',
    socket_device_id: 'app-record-79',
    name: 'Local',
    status: 'online',
    device_type: 'local',
    is_default: true,
  },
]

test('preserves the open picker when discovery replaces a device alias with its proven address', () => {
  const { rerender } = render(
    <SingleWorkbenchPane pane={pane('app-record-79')} visible renderPane={renderPane} />
  )
  fireEvent.click(screen.getByText('Picker closed'))
  rerender(
    <SingleWorkbenchPane
      pane={pane('electron-local')}
      devices={devices}
      visible
      renderPane={renderPane}
    />
  )
  expect(screen.getByText('Picker open')).toBeInTheDocument()
  // A distinct device with the same task id must get a fresh pane.
  rerender(
    <SingleWorkbenchPane
      pane={pane('unrelated-device')}
      devices={devices}
      visible
      renderPane={renderPane}
    />
  )
  expect(screen.getByText('Picker closed')).toBeInTheDocument()
})

test('does not retain a pane through an ambiguous device alias', () => {
  const other: DeviceInfo = { ...devices[0], id: 80, device_id: 'other-runtime' }
  const { rerender } = render(
    <SingleWorkbenchPane pane={pane('app-record-79')} visible renderPane={renderPane} />
  )
  fireEvent.click(screen.getByText('Picker closed'))
  rerender(
    <SingleWorkbenchPane
      pane={pane('electron-local')}
      devices={[...devices, other]}
      visible
      renderPane={renderPane}
    />
  )
  expect(screen.getByText('Picker closed')).toBeInTheDocument()
})

function Split({
  pane: current,
  devices: knownDevices = [],
  knownPanes = [current],
}: {
  pane: WorkbenchPaneIdentity
  devices?: DeviceInfo[]
  knownPanes?: WorkbenchPaneIdentity[]
}) {
  const key = getWorkbenchPaneKey(current)
  return (
    <>
      <div id={WORKBENCH_SPLIT_ACTIONS_PORTAL_ID} />
      <SplitWorkbenchPaneStack
        activePane={current}
        devices={knownDevices}
        layout={createWorkbenchLayout(key)}
        showWorkbenchBackground={false}
        validRuntimeKeys={knownPanes.map(getWorkbenchPaneKey)}
        activeTestId="active"
        workbenchVisible
        resolvePane={paneKey =>
          knownPanes.find(item => getWorkbenchPaneKey(item) === paneKey) ?? null
        }
        getPaneTitle={() => 'Task'}
        onPaneFocus={() => {}}
        onLayoutFocus={() => {}}
        onLayoutClose={() => createWorkbenchLayout(key)}
        onLayoutSplit={() => {}}
        onLayoutPlace={() => {}}
        onLayoutSizesChange={() => {}}
        renderPane={renderPane}
      />
    </>
  )
}

test('preserves the real desktop split portal and host when a discovered device alias resolves', () => {
  const { rerender } = render(<Split pane={pane('app-record-79')} />)
  const host = screen.getByText('Picker closed').closest('[data-workbench-pane-host]')
  fireEvent.click(screen.getByText('Picker closed'))
  rerender(<Split pane={pane('electron-local')} devices={devices} />)
  expect(screen.getByText('Picker open')).toBeInTheDocument()
  expect(screen.getByText('Picker open').closest('[data-workbench-pane-host]')).toBe(host)
  expect(host).toHaveAttribute('data-workbench-pane-host', 'runtime:electron-local:same-task')
  rerender(<Split pane={pane('unrelated-device')} devices={devices} />)
  expect(screen.getByText('Picker closed')).toBeInTheDocument()
})

test('does not migrate a split host through an ambiguous executor alias', () => {
  const other: DeviceInfo = { ...devices[0], id: 80, device_id: 'other-runtime' }
  const { rerender } = render(<Split pane={pane('app-record-79')} />)
  fireEvent.click(screen.getByText('Picker closed'))
  rerender(<Split pane={pane('electron-local')} devices={[...devices, other]} />)
  expect(screen.getByText('Picker closed')).toBeInTheDocument()
})

test('reuses the most recent task pane and disposes it when it leaves the valid task list', () => {
  const task = pane('electron-local')
  const blank: WorkbenchPaneIdentity = { currentProject: null, currentRuntimeTask: null }
  const { rerender } = render(<Split pane={task} knownPanes={[task]} />)
  fireEvent.click(screen.getByText('Picker closed'))
  const picker = screen.getByText('Picker open')
  const host = picker.closest('[data-workbench-pane-host]')

  rerender(<Split pane={blank} knownPanes={[task]} />)
  expect(picker).not.toBeInTheDocument()
  expect(host).toContainElement(picker)

  rerender(<Split pane={task} knownPanes={[task]} />)
  expect(screen.getByText('Picker open')).toBe(picker)

  rerender(<Split pane={blank} knownPanes={[task]} />)
  rerender(<Split pane={blank} knownPanes={[]} />)
  expect(host).not.toContainElement(picker)
})

test('retains at most one previous task in single-pane navigation', () => {
  const tasks = ['device-a', 'device-b', 'device-c'].map(pane)
  const { rerender } = render(<Split pane={tasks[0]} knownPanes={tasks} />)
  const picker = screen.getByText('Picker closed')
  const host = picker.closest('[data-workbench-pane-host]')
  rerender(<Split pane={tasks[1]} knownPanes={tasks} />)
  expect(host).toContainElement(picker)
  rerender(<Split pane={tasks[2]} knownPanes={tasks} />)
  expect(host).not.toContainElement(picker)
})
