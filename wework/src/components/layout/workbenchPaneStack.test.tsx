import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import {
  CachedWorkbenchPaneStack,
  getRunningRuntimeWorkbenchPaneKeys,
  getWorkbenchPaneKey,
  type WorkbenchPaneIdentity,
} from './workbenchPaneStack'

let mountCounter = 0

describe('workbenchPaneStack', () => {
  test('keeps a runtime pane mounted when its workspace path is filled later', async () => {
    function RuntimePaneStackProbe() {
      const [pane, setPane] = useState<WorkbenchPaneIdentity>({
        currentRuntimeTask: {
          deviceId: 'device-1',
          taskId: 101,
          taskId: 'runtime-1',
        },
        currentProject: null,
      })

      return (
        <div>
          <button
            type="button"
            onClick={() =>
              setPane({
                currentRuntimeTask: {
                  deviceId: 'device-1',
                  taskId: 101,
                  taskId: 'runtime-1',
                  workspacePath: '/workspace/project-alpha',
                },
                currentProject: null,
              })
            }
          >
            fill workspace path
          </button>
          <CachedWorkbenchPaneStack
            activePane={pane}
            maxPanes={5}
            renderPane={activePane => <RuntimePane pane={activePane} />}
          />
        </div>
      )
    }

    render(<RuntimePaneStackProbe />)

    const firstMountId = screen.getByTestId('runtime-pane-mount-id').textContent
    expect(screen.getByTestId('runtime-pane-workspace-path')).toHaveTextContent('none')

    await userEvent.click(screen.getByText('fill workspace path'))

    expect(screen.getByTestId('runtime-pane-mount-id')).toHaveTextContent(firstMountId ?? '')
    expect(screen.getByTestId('runtime-pane-workspace-path')).toHaveTextContent(
      '/workspace/project-alpha'
    )
  })

  test('uses task identity rather than workspace path for runtime pane keys', () => {
    const basePane: WorkbenchPaneIdentity = {
      currentRuntimeTask: {
        deviceId: 'device-1',
        taskId: 101,
        taskId: 'runtime-1',
      },
      currentProject: null,
    }
    const resolvedPane: WorkbenchPaneIdentity = {
      currentRuntimeTask: {
        deviceId: 'device-1',
        taskId: 101,
        taskId: 'runtime-1',
        workspacePath: '/workspace/project-alpha',
      },
      currentProject: null,
    }

    expect(getWorkbenchPaneKey(basePane)).toBe(getWorkbenchPaneKey(resolvedPane))
  })

  test('keeps pinned runtime panes mounted beyond the normal cache limit', async () => {
    const panes: WorkbenchPaneIdentity[] = [
      { currentRuntimeTask: { deviceId: 'device-1', taskId: 101 }, currentProject: null },
      { currentRuntimeTask: { deviceId: 'device-1', taskId: 102 }, currentProject: null },
      { currentRuntimeTask: { deviceId: 'device-1', taskId: 103 }, currentProject: null },
    ]
    const pinnedKeys = [getWorkbenchPaneKey(panes[0])]

    function RuntimePaneStackProbe() {
      const [index, setIndex] = useState(0)
      return (
        <div>
          <button type="button" onClick={() => setIndex(1)}>
            open second
          </button>
          <button type="button" onClick={() => setIndex(2)}>
            open third
          </button>
          <CachedWorkbenchPaneStack
            activePane={panes[index]}
            maxPanes={1}
            pinnedKeys={pinnedKeys}
            renderPane={activePane => <RuntimePane pane={activePane} />}
          />
        </div>
      )
    }

    render(<RuntimePaneStackProbe />)

    await userEvent.click(screen.getByText('open second'))
    await userEvent.click(screen.getByText('open third'))

    expect(screen.getByTestId('runtime-pane-101')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-pane-103')).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-pane-102')).not.toBeInTheDocument()
  })

  test('derives running runtime pane keys from task ids', () => {
    expect(
      getRunningRuntimeWorkbenchPaneKeys({
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            deviceWorkspaces: [
              {
                deviceId: 'device-1',
                workspacePath: '/workspace/project-alpha',
                available: true,
                mapped: true,
                tasks: [
                  { taskId: 101, workspacePath: '/workspace/project-alpha', title: 'A', runtime: 'codex', running: true },
                  { taskId: 102, workspacePath: '/workspace/project-alpha', title: 'B', runtime: 'codex', running: false },
                ],
              },
            ],
            totalTasks: 2,
          },
        ],
        chats: [],
        totalTasks: 2,
      })
    ).toEqual(['runtime:device-1:101'])
  })
})

function RuntimePane({ pane }: { pane: WorkbenchPaneIdentity }) {
  const [mountId] = useState(() => {
    mountCounter += 1
    return String(mountCounter)
  })

  return (
    <div data-testid={`runtime-pane-${pane.currentRuntimeTask?.taskId ?? 'project'}`}>
      <span data-testid="runtime-pane-mount-id">{mountId}</span>
      <span data-testid="runtime-pane-workspace-path">
        {pane.currentRuntimeTask?.workspacePath ?? 'none'}
      </span>
    </div>
  )
}
