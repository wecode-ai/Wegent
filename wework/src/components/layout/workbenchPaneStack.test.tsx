import {
  WORKBENCH_SPLIT_ACTIONS_PORTAL_ID,
  WorkbenchPaneHeaderActionsPortal,
} from '@/components/topnav/TitlebarActionsPortal'
import { render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWorkbenchPaneKey, type WorkbenchPaneIdentity } from './workbenchPaneIdentity'
import {
  useWorkbenchPaneActive,
  useWorkbenchPaneHeaderActionsPortalId,
  useWorkbenchPaneVisible,
} from './workbenchPanePresentation'
import { SplitWorkbenchPaneStack } from './workbenchPaneStack'
import {
  closeWorkbenchPane,
  createWorkbenchLayout,
  focusWorkbenchPane,
  parsePersistedWorkbenchLayout,
  placeWorkbenchTask,
  serializeWorkbenchLayout,
  splitWorkbenchPane,
  updateWorkbenchSplitSizes,
} from './workbenchSplitLayout'

const paneOne: WorkbenchPaneIdentity = {
  currentRuntimeTask: { deviceId: 'device', taskId: 'one' },
  currentProject: null,
}
const paneTwo: WorkbenchPaneIdentity = {
  currentRuntimeTask: { deviceId: 'device', taskId: 'two' },
  currentProject: null,
}
const paneThree: WorkbenchPaneIdentity = {
  currentRuntimeTask: { deviceId: 'device', taskId: 'three' },
  currentProject: null,
}
const blankPane: WorkbenchPaneIdentity = {
  currentRuntimeTask: null,
  currentProject: null,
  standaloneChatKey: 1,
}
const panes = [paneOne, paneTwo, paneThree]
const paneOneKey = getWorkbenchPaneKey(paneOne)
const paneTwoKey = getWorkbenchPaneKey(paneTwo)

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  )
})

beforeEach(() => {
  localStorage.removeItem('workbench-split-test')
})

function PaneContent({ pane }: { pane: WorkbenchPaneIdentity }) {
  const portalId = useWorkbenchPaneHeaderActionsPortalId()
  const active = useWorkbenchPaneActive()
  const visible = useWorkbenchPaneVisible()
  const [mountId] = useState(() => crypto.randomUUID())
  const name = pane.currentRuntimeTask?.taskId ?? 'blank'
  return (
    <>
      {visible && portalId ? (
        <WorkbenchPaneHeaderActionsPortal targetId={portalId}>
          <button type="button" data-testid={`pane-header-action-${name}`}>
            {name} action
          </button>
        </WorkbenchPaneHeaderActionsPortal>
      ) : null}
      <div
        data-testid={`pane-content-${name}`}
        data-active={active}
        data-visible={visible}
        data-mount-id={mountId}
      />
    </>
  )
}

function Stack({
  activePane,
  activeTestId = 'active-pane',
  availablePanes = panes,
  onPaneFocus = () => undefined,
  retainedResourceKeys = [],
  workbenchVisible = true,
  followActivePane = false,
  showWorkbenchBackground = false,
}: {
  activePane: WorkbenchPaneIdentity
  activeTestId?: string | null
  availablePanes?: WorkbenchPaneIdentity[]
  onPaneFocus?: (pane: WorkbenchPaneIdentity) => void
  retainedResourceKeys?: string[]
  workbenchVisible?: boolean
  followActivePane?: boolean
  showWorkbenchBackground?: boolean
}) {
  const availablePaneByKey = new Map(
    availablePanes.map(pane => [getWorkbenchPaneKey(pane), pane] as const)
  )
  const [layout, setLayout] = useState(
    () =>
      parsePersistedWorkbenchLayout(localStorage.getItem('workbench-split-test')) ??
      createWorkbenchLayout(getWorkbenchPaneKey(activePane))
  )
  // Production layout state belongs to the parent. This flag lets tests emulate the
  // former active-pane-following parent behavior for host retention and blank replacement.
  const renderedLayout = followActivePane
    ? createWorkbenchLayout(getWorkbenchPaneKey(activePane))
    : layout
  return (
    <>
      <div id={WORKBENCH_SPLIT_ACTIONS_PORTAL_ID} />
      <SplitWorkbenchPaneStack
        activePane={activePane}
        layout={renderedLayout}
        showWorkbenchBackground={showWorkbenchBackground}
        validRuntimeKeys={[...availablePaneByKey.keys()]}
        retainedResourceKeys={retainedResourceKeys}
        activeTestId={activeTestId}
        workbenchVisible={workbenchVisible}
        resolvePane={key => availablePaneByKey.get(key) ?? null}
        getPaneTitle={pane => pane.currentRuntimeTask?.taskId ?? 'blank'}
        onPaneFocus={onPaneFocus}
        onLayoutFocus={paneId => {
          const next = focusWorkbenchPane(layout, paneId)
          setLayout(next)
          return next
        }}
        onLayoutClose={paneId => {
          const next = closeWorkbenchPane(layout, paneId)
          setLayout(next)
          return next
        }}
        onLayoutSplit={(paneId, direction) =>
          setLayout(current => splitWorkbenchPane(current, paneId, direction))
        }
        onLayoutPlace={(paneKey, paneId, position) =>
          setLayout(current => placeWorkbenchTask(current, paneKey, paneId, position))
        }
        onLayoutSizesChange={(splitId, sizes) =>
          setLayout(current => updateWorkbenchSplitSizes(current, splitId, sizes))
        }
        renderPane={pane => <PaneContent pane={pane} />}
      />
    </>
  )
}

function persistTwoPaneLayout() {
  const initial = createWorkbenchLayout(paneOneKey)
  const split = placeWorkbenchTask(initial, paneTwoKey, initial.focusedPaneId, 'right')
  localStorage.setItem('workbench-split-test', serializeWorkbenchLayout(split))
  return split
}

describe('SplitWorkbenchPaneStack', () => {
  it('keeps the focused pane active for task-scoped resources while its workspace tab is hidden', () => {
    persistTwoPaneLayout()
    render(<Stack activePane={paneOne} activeTestId={null} workbenchVisible={false} />)

    expect(screen.getByTestId('pane-content-one')).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId('pane-content-one')).toHaveAttribute('data-visible', 'false')
    expect(screen.getByTestId('pane-content-two')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('pane-content-two')).toHaveAttribute('data-visible', 'false')
    expect(screen.queryByTestId('pane-header-action-one')).not.toBeInTheDocument()
    expect(screen.queryByTestId('pane-header-action-two')).not.toBeInTheDocument()
    expect(screen.queryByTestId('active-pane')).not.toBeInTheDocument()
  })

  it('replaces a startup blank identity without retaining it', async () => {
    const view = render(<Stack activePane={blankPane} followActivePane />)
    expect(screen.getByTestId('pane-content-blank')).toBeVisible()

    view.rerender(<Stack activePane={paneOne} followActivePane />)

    await waitFor(() => {
      expect(screen.queryByTestId('pane-content-blank')).not.toBeInTheDocument()
      expect(screen.getByTestId('pane-content-one')).toBeVisible()
    })
  })
})
