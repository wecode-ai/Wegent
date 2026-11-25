import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { expect, test } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import { SingleWorkbenchPane } from './workbenchPanePresentation'
import { getWorkbenchPaneKey, type WorkbenchPaneIdentity } from './workbenchPaneIdentity'
import { SplitWorkbenchPaneStack } from './workbenchPaneStack'
import { createDesktopPaneContextSource } from './desktopPaneContextSource'
import { createWorkbenchLayout, splitWorkbenchPane } from './workbenchSplitLayout'
import { WORKBENCH_SPLIT_ACTIONS_PORTAL_ID } from '@/components/topnav/TitlebarActionsPortal'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'

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
  showSplit = false,
}: {
  pane: WorkbenchPaneIdentity
  devices?: DeviceInfo[]
  showSplit?: boolean
}) {
  const key = getWorkbenchPaneKey(current)
  const layout = createWorkbenchLayout(key)
  return (
    <>
      <div id={WORKBENCH_SPLIT_ACTIONS_PORTAL_ID} />
      <SplitWorkbenchPaneStack
        activePane={current}
        devices={knownDevices}
        layout={showSplit ? splitWorkbenchPane(layout, layout.focusedPaneId, 'right') : layout}
        showWorkbenchBackground={false}
        validRuntimeKeys={[key]}
        activeTestId="active"
        workbenchVisible
        resolvePane={() => current}
        runtimeWork={null}
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

test('pane metadata keeps its identity when a different task starts a turn', () => {
  const address = { deviceId: 'electron-local', taskId: 'current' }
  const store = new RuntimeTaskLifecycleStore('pane-metadata')
  const source = createDesktopPaneContextSource(store).observe({
    active: true,
    current: address,
    resolved: null,
    runtimeWork: null,
    openTask: async () => undefined,
  })
  const initial = source.getSnapshot()

  store.turnStarted({ ...address, taskId: 'other' }, 'other-turn')
  expect(source.getSnapshot()).toBe(initial)

  store.syncRuntimeTask(address, {
    runtime: 'codex',
    workspacePath: '/work',
    taskId: address.taskId,
    title: 'Current task',
    threadId: 'late-thread',
  })
  expect(source.getSnapshot().currentRuntimeConversationSource?.threadId).toBe('late-thread')
})

test('a split title follows an unlisted task without rebuilding its pane', () => {
  const current = pane('electron-local')
  const address = current.currentRuntimeTask!
  const store = new RuntimeTaskLifecycleStore('split-title')
  const summary = {
    runtime: 'codex' as const,
    workspacePath: '/work',
    taskId: address.taskId,
    title: 'Original title',
  }
  store.syncRuntimeTask(address, summary)
  render(
    <RuntimeTaskLifecycleProvider store={store}>
      <Split pane={current} devices={devices} showSplit />
    </RuntimeTaskLifecycleProvider>
  )

  fireEvent.click(screen.getByText('Picker closed'))
  const host = screen.getByText('Picker open').closest('[data-workbench-pane-host]')
  expect(screen.getByRole('button', { name: 'Original title' })).toBeInTheDocument()

  act(() => store.syncRuntimeTask(address, { ...summary, title: 'Updated title' }))

  expect(screen.getByRole('button', { name: 'Updated title' })).toBeInTheDocument()
  expect(screen.getByText('Picker open').closest('[data-workbench-pane-host]')).toBe(host)
})

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
