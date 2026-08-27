import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKBENCH_SPLIT_ACTIONS_PORTAL_ID,
  WorkbenchPaneHeaderActionsPortal,
} from '@/components/topnav/TitlebarActionsPortal'
import {
  WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT,
  WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT,
  type WorkbenchSidebarPaneDragEndData,
} from './workbenchPaneDrag'
import { getWorkbenchPaneKey, type WorkbenchPaneIdentity } from './workbenchPaneIdentity'
import {
  useWorkbenchPaneActive,
  useWorkbenchPaneHeaderActionsPortalId,
  useWorkbenchPaneVisible,
} from './workbenchPanePresentation'
import { SplitWorkbenchPaneStack } from './workbenchPaneStack'
import {
  closeWorkbenchPane,
  collectWorkbenchPanes,
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
const paneByKey = new Map(panes.map(pane => [getWorkbenchPaneKey(pane), pane] as const))
const paneOneKey = getWorkbenchPaneKey(paneOne)
const paneTwoKey = getWorkbenchPaneKey(paneTwo)
const paneThreeKey = getWorkbenchPaneKey(paneThree)

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
  onPaneFocus = () => undefined,
  retainedResourceKeys = [],
  workbenchVisible = true,
  followActivePane = false,
}: {
  activePane: WorkbenchPaneIdentity
  activeTestId?: string | null
  onPaneFocus?: (pane: WorkbenchPaneIdentity) => void
  retainedResourceKeys?: string[]
  workbenchVisible?: boolean
  followActivePane?: boolean
}) {
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
        validRuntimeKeys={[...paneByKey.keys()]}
        retainedResourceKeys={retainedResourceKeys}
        activeTestId={activeTestId}
        workbenchVisible={workbenchVisible}
        resolvePane={key => paneByKey.get(key) ?? null}
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
  it('renders exactly one task in single-pane mode', () => {
    render(<Stack activePane={paneOne} />)

    expect(screen.getByTestId('pane-content-one')).toBeVisible()
    expect(screen.getByTestId('pane-content-one')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('pane-content-one')).toHaveAttribute('data-visible', 'true')
    expect(screen.queryByTestId(/^workbench-pane-title-/)).not.toBeInTheDocument()
    expect(screen.getAllByTestId('active-pane')).toHaveLength(1)
  })

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

  it('does not mutate the controlled layout when the external active pane changes', async () => {
    const view = render(<Stack activePane={paneOne} />)

    view.rerender(<Stack activePane={paneTwo} />)

    await waitFor(() => {
      expect(screen.getByTestId('pane-content-one')).toBeVisible()
      expect(screen.queryByTestId('pane-content-two')).not.toBeInTheDocument()
    })
  })

  it('keeps retained resources mounted outside the document and restores their host', async () => {
    const view = render(
      <Stack activePane={paneOne} retainedResourceKeys={[paneOneKey]} followActivePane />
    )
    const mountId = screen.getByTestId('pane-content-one').dataset.mountId

    view.rerender(
      <Stack activePane={paneTwo} retainedResourceKeys={[paneOneKey]} followActivePane />
    )
    await waitFor(() => {
      expect(screen.queryByTestId('pane-content-one')).not.toBeInTheDocument()
      expect(screen.getByTestId('pane-content-two')).toBeVisible()
    })

    view.rerender(
      <Stack activePane={paneOne} retainedResourceKeys={[paneOneKey]} followActivePane />
    )
    await waitFor(() =>
      expect(screen.getByTestId('pane-content-one')).toHaveAttribute('data-mount-id', mountId)
    )
  })

  it('restores two visible tasks with independent title bars and actions', async () => {
    persistTwoPaneLayout()
    render(<Stack activePane={paneOne} />)

    expect(await screen.findByTestId('pane-content-one')).toBeVisible()
    expect(screen.getByTestId('pane-content-two')).toBeVisible()
    expect(screen.getAllByTestId(/^workbench-pane-title-/)).toHaveLength(2)
    expect(screen.getByTestId('pane-header-action-one')).toBeVisible()
    expect(screen.getByTestId('pane-header-action-two')).toBeVisible()
  })

  it('focuses an existing task without remounting either pane', async () => {
    persistTwoPaneLayout()
    const onPaneFocus = vi.fn()
    const view = render(<Stack activePane={paneOne} onPaneFocus={onPaneFocus} />)
    const oneMount = screen.getByTestId('pane-content-one').dataset.mountId
    const twoMount = screen.getByTestId('pane-content-two').dataset.mountId

    view.rerender(<Stack activePane={paneTwo} onPaneFocus={onPaneFocus} />)

    await waitFor(() => expect(screen.getByTestId('pane-content-two')).toBeVisible())
    expect(screen.getByTestId('pane-content-one')).toHaveAttribute('data-mount-id', oneMount)
    expect(screen.getByTestId('pane-content-two')).toHaveAttribute('data-mount-id', twoMount)
  })

  it('shows one task in focus view and restores the split with Escape', async () => {
    persistTwoPaneLayout()
    render(<Stack activePane={paneOne} />)
    const focusButtons = screen.getAllByTestId(/^workbench-focus-pane-/)

    fireEvent.click(focusButtons[0])
    await waitFor(() =>
      expect(screen.getByTestId('workbench-split-layout')).toHaveAttribute('data-focused-pane')
    )
    expect(screen.getByTestId('pane-content-one')).toBeVisible()
    expect(screen.queryByTestId('pane-content-two')).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.getByTestId('pane-content-two')).toBeVisible())
  })

  it('removes the complete pane when its close action is used', async () => {
    persistTwoPaneLayout()
    render(<Stack activePane={paneOne} />)

    fireEvent.click(screen.getAllByTestId(/^workbench-close-pane-/)[1])

    await waitFor(() => {
      expect(screen.queryByTestId('pane-content-two')).not.toBeInTheDocument()
      expect(screen.getByTestId('pane-content-one')).toBeVisible()
      expect(screen.queryByTestId(/^workbench-pane-title-/)).not.toBeInTheDocument()
    })
  })

  it('uses a dominant center target and small directional targets while dragging', () => {
    persistTwoPaneLayout()
    render(<Stack activePane={paneOne} />)

    act(() => {
      window.dispatchEvent(
        new CustomEvent(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT, {
          detail: { paneKey: paneThreeKey },
        })
      )
    })

    const targets = screen.getAllByTestId(/^workbench-pane-drop-targets-/)
    expect(targets).toHaveLength(2)
    expect(screen.getAllByTestId(/drop:.*:center/)[0].className).toContain('bg-background/95')
    expect(targets[0].className).toContain('grid-cols-[14%_minmax(0,1fr)_14%]')
  })

  it('places a sidebar task on a pane edge', async () => {
    const split = persistTwoPaneLayout()
    const targetPaneId = collectWorkbenchPanes(split.root)[1].id
    render(<Stack activePane={paneOne} />)

    act(() => {
      window.dispatchEvent(
        new CustomEvent(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT, {
          detail: { paneKey: paneThreeKey },
        })
      )
    })
    const actualTarget = screen.getByTestId(`drop:${targetPaneId}:right`)
    vi.spyOn(document, 'elementsFromPoint').mockReturnValue([actualTarget])
    const detail: WorkbenchSidebarPaneDragEndData = {
      paneKey: paneThreeKey,
      clientX: 10,
      clientY: 10,
      handled: false,
    }

    act(() => {
      window.dispatchEvent(new CustomEvent(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, { detail }))
    })

    await waitFor(() => expect(screen.getByTestId('pane-content-three')).toBeVisible())
    expect(detail.handled).toBe(true)
    expect(screen.getAllByTestId(/^workbench-pane-title-/)).toHaveLength(3)
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
