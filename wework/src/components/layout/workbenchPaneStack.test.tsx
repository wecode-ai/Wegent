import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import {
  CachedWorkbenchPaneStack,
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
          localTaskId: 'runtime-1',
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
                  localTaskId: 'runtime-1',
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
        localTaskId: 'runtime-1',
      },
      currentProject: null,
    }
    const resolvedPane: WorkbenchPaneIdentity = {
      currentRuntimeTask: {
        deviceId: 'device-1',
        localTaskId: 'runtime-1',
        workspacePath: '/workspace/project-alpha',
      },
      currentProject: null,
    }

    expect(getWorkbenchPaneKey(basePane)).toBe(getWorkbenchPaneKey(resolvedPane))
  })
})

function RuntimePane({ pane }: { pane: WorkbenchPaneIdentity }) {
  const [mountId] = useState(() => {
    mountCounter += 1
    return String(mountCounter)
  })

  return (
    <div>
      <span data-testid="runtime-pane-mount-id">{mountId}</span>
      <span data-testid="runtime-pane-workspace-path">
        {pane.currentRuntimeTask?.workspacePath ?? 'none'}
      </span>
    </div>
  )
}
