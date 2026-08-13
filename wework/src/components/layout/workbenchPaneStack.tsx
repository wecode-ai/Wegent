/* eslint-disable react-hooks/refs -- Pane hosts intentionally preserve live task sessions across layout changes. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  Columns2,
  Focus,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Square,
  X,
} from 'lucide-react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { ActionMenu } from '@/components/common/ActionMenu'
import { TitlebarTooltip } from '@/components/topnav/TitlebarTooltip'
import { WorkbenchSplitActionsPortal } from '@/components/topnav/TitlebarActionsPortal'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import {
  WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT,
  WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT,
  type WorkbenchSidebarPaneDragData,
  type WorkbenchSidebarPaneDragEndData,
} from './workbenchPaneDrag'
import { getWorkbenchPaneKey, type WorkbenchPaneIdentity } from './workbenchPaneIdentity'
import {
  WorkbenchPaneHost,
  WorkbenchPanePortal,
  type WorkbenchPanePresentation,
} from './workbenchPanePresentation'
import styles from './workbenchPaneStack.module.css'
import {
  closeWorkbenchPane,
  collectWorkbenchPaneKeys,
  collectWorkbenchPanes,
  createWorkbenchLayout,
  findWorkbenchPane,
  focusWorkbenchPane,
  openWorkbenchPane,
  parsePersistedWorkbenchLayout,
  placeWorkbenchTask,
  pruneWorkbenchLayout,
  serializeWorkbenchLayout,
  splitWorkbenchPane,
  updateWorkbenchSplitSizes,
  type WorkbenchLayoutNode,
  type WorkbenchLayoutState,
  type WorkbenchPaneNode,
  type WorkbenchSplitDirection,
  type WorkbenchSplitNode,
} from './workbenchSplitLayout'

const MIN_PANE_WIDTH = 320
const MIN_PANE_HEIGHT = 240

interface SplitWorkbenchPaneStackProps {
  activePane: WorkbenchPaneIdentity
  storageKey: string
  validRuntimeKeys: string[]
  retainedResourceKeys: string[]
  runtimeKeysReady: boolean
  activeTestId: string
  workbenchVisible: boolean
  resolvePane: (paneKey: string) => WorkbenchPaneIdentity | null
  getPaneTitle: (pane: WorkbenchPaneIdentity) => string
  onPaneFocus: (pane: WorkbenchPaneIdentity) => void
  onSplitModeChange?: (split: boolean) => void
  renderPane: (pane: WorkbenchPaneIdentity) => ReactNode
}

interface DropTarget {
  paneId: string
  position: 'center' | WorkbenchSplitDirection
}

interface LayoutLabels {
  paneMenu: string
  splitLeft: string
  splitRight: string
  splitUp: string
  splitDown: string
  closePane: string
  focusTask: string
  restoreSplit: string
  emptyTitle: string
  emptyDescription: string
  resize: string
  dropLeft: string
  dropRight: string
  dropUp: string
  dropDown: string
  dropCenter: string
}

export function SplitWorkbenchPaneStack({
  activePane,
  storageKey,
  validRuntimeKeys,
  retainedResourceKeys = [],
  runtimeKeysReady,
  activeTestId,
  workbenchVisible,
  resolvePane,
  getPaneTitle,
  onPaneFocus,
  onSplitModeChange,
  renderPane,
}: SplitWorkbenchPaneStackProps) {
  const { t } = useTranslation()
  const activeKey = getWorkbenchPaneKey(activePane)
  const paneCacheRef = useRef(new Map<string, WorkbenchPaneIdentity>())
  const paneHostCacheRef = useRef(new Map<string, HTMLDivElement>())
  const appliedActiveKeyRef = useRef(activeKey)
  const sidebarDragActiveRef = useRef(false)
  paneCacheRef.current.set(activeKey, activePane)

  const [layout, setLayout] = useState<WorkbenchLayoutState>(() => {
    const restored =
      typeof window === 'undefined'
        ? null
        : parsePersistedWorkbenchLayout(window.localStorage.getItem(storageKey))
    return restored ?? createWorkbenchLayout(activeKey)
  })
  const [draggedPaneKey, setDraggedPaneKey] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [focusedViewPaneId, setFocusedViewPaneId] = useState<string | null>(null)

  const labels: LayoutLabels = {
    paneMenu: t('workbench.split_pane_menu', '分屏操作'),
    splitLeft: t('workbench.split_left', '向左分屏'),
    splitRight: t('workbench.split_right', '向右分屏'),
    splitUp: t('workbench.split_up', '向上分屏'),
    splitDown: t('workbench.split_down', '向下分屏'),
    closePane: t('workbench.close_split_pane', '关闭分屏'),
    focusTask: t('workbench.focus_split_task', '单独查看此任务'),
    restoreSplit: t('workbench.restore_split_view', '返回分屏'),
    emptyTitle: t('workbench.split_empty_title', '选择一个任务'),
    emptyDescription: t(
      'workbench.split_empty_description',
      '从左侧任务列表拖入一个任务，或点击任务在此处打开'
    ),
    resize: t('workbench.resize_split_panes', '调整分屏大小'),
    dropLeft: t('workbench.drop_left', '左侧'),
    dropRight: t('workbench.drop_right', '右侧'),
    dropUp: t('workbench.drop_up', '上方'),
    dropDown: t('workbench.drop_down', '下方'),
    dropCenter: t('workbench.drop_center', '当前区域'),
  }

  const resolveCachedPane = useCallback(
    (paneKey: string) => {
      const cached = paneCacheRef.current.get(paneKey)
      if (cached) return cached
      const resolved = resolvePane(paneKey)
      if (resolved) paneCacheRef.current.set(paneKey, resolved)
      return resolved
    },
    [resolvePane]
  )

  const getPaneHost = useCallback((paneKey: string) => {
    const cached = paneHostCacheRef.current.get(paneKey)
    if (cached) return cached
    if (typeof document === 'undefined') return null
    const host = document.createElement('div')
    host.className = 'h-full min-h-0 min-w-0'
    host.dataset.workbenchPaneHost = paneKey
    paneHostCacheRef.current.set(paneKey, host)
    return host
  }, [])

  useLayoutEffect(() => {
    if (appliedActiveKeyRef.current === activeKey) return
    appliedActiveKeyRef.current = activeKey
    setLayout(current => openWorkbenchPane(current, activeKey))
  }, [activeKey])

  useEffect(() => {
    if (!runtimeKeysReady) return
    const validKeys = new Set([...validRuntimeKeys, activeKey])
    // Runtime hydration is external state; the persisted layout must discard tasks deleted elsewhere.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLayout(
      current => pruneWorkbenchLayout(current, validKeys) ?? createWorkbenchLayout(activeKey)
    )
  }, [activeKey, runtimeKeysReady, validRuntimeKeys])

  useEffect(() => {
    window.localStorage.setItem(storageKey, serializeWorkbenchLayout(layout))
  }, [layout, storageKey])

  const panes = collectWorkbenchPanes(layout.root)
  const splitMode = panes.length > 1
  const layoutPaneKeys = collectWorkbenchPaneKeys(layout.root)
  const retainedPaneKeys = retainedResourceKeys.filter(
    key =>
      !layoutPaneKeys.includes(key) &&
      (!key.startsWith('runtime:') || validRuntimeKeys.includes(key))
  )
  const mountedPaneKeys = [...layoutPaneKeys, ...retainedPaneKeys]
  const mountedPaneKeySignature = mountedPaneKeys.join('\u0000')
  const focusedViewPane =
    focusedViewPaneId === null ? null : findWorkbenchPane(layout.root, focusedViewPaneId)
  const effectiveFocusedViewPaneId = focusedViewPane?.id ?? null
  const visibleRoot = focusedViewPane ?? layout.root
  const presentations = collectPanePresentations(
    layout,
    workbenchVisible,
    effectiveFocusedViewPaneId,
    retainedPaneKeys
  )

  useEffect(() => {
    const retainedKeys = new Set(
      mountedPaneKeySignature ? mountedPaneKeySignature.split('\u0000') : []
    )
    paneHostCacheRef.current.forEach((host, paneKey) => {
      if (retainedKeys.has(paneKey)) return
      host.remove()
      paneHostCacheRef.current.delete(paneKey)
      paneCacheRef.current.delete(paneKey)
    })
  }, [mountedPaneKeySignature])

  useEffect(() => {
    onSplitModeChange?.(splitMode)
  }, [onSplitModeChange, splitMode])

  useEffect(() => {
    if (!effectiveFocusedViewPaneId) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setFocusedViewPaneId(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [effectiveFocusedViewPaneId])

  const focusPane = useCallback(
    (paneId: string) => {
      const node = findWorkbenchPane(layout.root, paneId)
      if (!node?.paneKey) return
      const pane = resolveCachedPane(node.paneKey)
      if (!pane) return
      setLayout(current => focusWorkbenchPane(current, paneId))
      onPaneFocus(pane)
    },
    [layout.root, onPaneFocus, resolveCachedPane, setLayout]
  )

  const closePane = useCallback(
    (paneId: string) => {
      setFocusedViewPaneId(current => (current === paneId ? null : current))
      setLayout(current => {
        const next = closeWorkbenchPane(current, paneId)
        const nextNode = findWorkbenchPane(next.root, next.focusedPaneId)
        const nextPane = nextNode?.paneKey ? resolveCachedPane(nextNode.paneKey) : null
        if (nextPane) queueMicrotask(() => onPaneFocus(nextPane))
        return next
      })
    },
    [onPaneFocus, resolveCachedPane, setFocusedViewPaneId, setLayout]
  )

  const splitPane = useCallback(
    (paneId: string, direction: WorkbenchSplitDirection) => {
      setFocusedViewPaneId(null)
      setLayout(current => splitWorkbenchPane(current, paneId, direction))
    },
    [setFocusedViewPaneId, setLayout]
  )

  const placeTask = useCallback(
    (paneKey: string, target: DropTarget) => {
      const pane = resolveCachedPane(paneKey)
      if (!pane) return
      setFocusedViewPaneId(null)
      setLayout(current => placeWorkbenchTask(current, paneKey, target.paneId, target.position))
      queueMicrotask(() => onPaneFocus(pane))
    },
    [onPaneFocus, resolveCachedPane, setFocusedViewPaneId, setLayout]
  )

  useEffect(() => {
    const readDropTarget = (clientX: number, clientY: number): DropTarget | null => {
      const element = document
        .elementsFromPoint(clientX, clientY)
        .map(candidate =>
          candidate.closest<HTMLElement>('[data-workbench-pane-drop-target="true"]')
        )
        .find((candidate): candidate is HTMLElement => candidate !== null)
      const paneId = element?.dataset.workbenchPaneId
      const position = element?.dataset.workbenchPaneDropPosition as
        | DropTarget['position']
        | undefined
      return paneId && position ? { paneId, position } : null
    }
    const handleDragStart = (event: Event) => {
      const detail = (event as CustomEvent<WorkbenchSidebarPaneDragData>).detail
      if (!detail?.paneKey) return
      sidebarDragActiveRef.current = true
      setDraggedPaneKey(detail.paneKey)
    }
    const handleDragMove = (event: PointerEvent) => {
      if (!sidebarDragActiveRef.current) return
      setDropTarget(readDropTarget(event.clientX, event.clientY))
    }
    const handleDragEnd = (event: Event) => {
      const detail = (event as CustomEvent<WorkbenchSidebarPaneDragEndData | null>).detail
      sidebarDragActiveRef.current = false
      const target = detail ? readDropTarget(detail.clientX, detail.clientY) : null
      if (detail && target) {
        detail.handled = true
        placeTask(detail.paneKey, target)
      }
      setDraggedPaneKey(null)
      setDropTarget(null)
    }
    window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT, handleDragStart)
    window.addEventListener('pointermove', handleDragMove, true)
    window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, handleDragEnd)
    return () => {
      window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT, handleDragStart)
      window.removeEventListener('pointermove', handleDragMove, true)
      window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, handleDragEnd)
    }
  }, [placeTask])

  return (
    <>
      {presentations.map(({ paneKey, ...presentation }) => {
        const pane = resolveCachedPane(paneKey)
        const host = getPaneHost(paneKey)
        if (!pane || !host) return null
        return (
          <WorkbenchPanePortal
            key={paneKey}
            pane={pane}
            host={host}
            renderPane={renderPane}
            {...presentation}
          />
        )
      })}
      {!splitMode && panes[0] ? (
        <WorkbenchSplitActionsPortal>
          <WorkbenchPaneMenu
            paneId={panes[0].id}
            canClose={false}
            labels={labels}
            onSplit={splitPane}
            onClose={closePane}
          />
        </WorkbenchSplitActionsPortal>
      ) : null}
      <div
        className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
        data-testid="workbench-split-layout"
        data-focused-pane={effectiveFocusedViewPaneId ?? undefined}
      >
        <WorkbenchLayoutRenderer
          node={visibleRoot}
          canonicalLayout={layout}
          totalPanes={panes.length}
          activeTestId={activeTestId}
          dragged={draggedPaneKey !== null}
          dropTarget={dropTarget}
          resolvePane={resolveCachedPane}
          getPaneTitle={getPaneTitle}
          getPaneHost={getPaneHost}
          labels={labels}
          focusedViewPaneId={effectiveFocusedViewPaneId}
          onFocus={focusPane}
          onClose={closePane}
          onSplit={splitPane}
          onToggleFocusedView={paneId =>
            setFocusedViewPaneId(current => (current === paneId ? null : paneId))
          }
          onSizesChanged={(splitId, sizes) =>
            setLayout(current => updateWorkbenchSplitSizes(current, splitId, sizes))
          }
        />
      </div>
    </>
  )
}

function collectPanePresentations(
  layout: WorkbenchLayoutState,
  workbenchVisible: boolean,
  focusedViewPaneId: string | null,
  retainedPaneKeys: string[]
): Array<WorkbenchPanePresentation & { paneKey: string }> {
  const split = collectWorkbenchPanes(layout.root).length > 1
  const visiblePresentations = collectWorkbenchPanes(layout.root).flatMap(pane => {
    if (!pane.paneKey) return []
    const visible = focusedViewPaneId === null || focusedViewPaneId === pane.id
    return [
      {
        paneKey: pane.paneKey,
        paneId: pane.id,
        visible: workbenchVisible && visible,
        focused: visible && layout.focusedPaneId === pane.id,
        headerActionsPortalId: split ? `workbench-pane-header-actions-${pane.id}` : null,
      },
    ]
  })
  return [
    ...visiblePresentations,
    ...retainedPaneKeys.map(paneKey => ({
      paneKey,
      paneId: `retained:${paneKey}`,
      visible: false,
      focused: false,
      headerActionsPortalId: null,
    })),
  ]
}

function WorkbenchLayoutRenderer({
  node,
  canonicalLayout,
  totalPanes,
  activeTestId,
  dragged,
  dropTarget,
  resolvePane,
  getPaneTitle,
  getPaneHost,
  labels,
  focusedViewPaneId,
  onFocus,
  onClose,
  onSplit,
  onToggleFocusedView,
  onSizesChanged,
}: {
  node: WorkbenchLayoutNode
  canonicalLayout: WorkbenchLayoutState
  totalPanes: number
  activeTestId: string
  dragged: boolean
  dropTarget: DropTarget | null
  resolvePane: (paneKey: string) => WorkbenchPaneIdentity | null
  getPaneTitle: (pane: WorkbenchPaneIdentity) => string
  getPaneHost: (paneKey: string) => HTMLDivElement | null
  labels: LayoutLabels
  focusedViewPaneId: string | null
  onFocus: (paneId: string) => void
  onClose: (paneId: string) => void
  onSplit: (paneId: string, direction: WorkbenchSplitDirection) => void
  onToggleFocusedView: (paneId: string) => void
  onSizesChanged: (splitId: string, sizes: Record<string, number>) => void
}) {
  if (node.type === 'pane') {
    return (
      <WorkbenchPaneView
        pane={node}
        focused={canonicalLayout.focusedPaneId === node.id}
        focusedView={focusedViewPaneId === node.id}
        totalPanes={totalPanes}
        activeTestId={activeTestId}
        dragged={dragged}
        dropTarget={dropTarget}
        resolvePane={resolvePane}
        getPaneTitle={getPaneTitle}
        getPaneHost={getPaneHost}
        labels={labels}
        onFocus={onFocus}
        onClose={onClose}
        onSplit={onSplit}
        onToggleFocusedView={onToggleFocusedView}
      />
    )
  }

  return (
    <Group
      id={node.id}
      orientation={node.orientation}
      defaultLayout={Object.fromEntries(
        node.children.map((child, index) => [
          child.id,
          node.sizes[index] ?? 100 / node.children.length,
        ])
      )}
      onLayoutChanged={(sizes, meta) => {
        if (meta.isUserInteraction) onSizesChanged(node.id, sizes)
      }}
      className="relative h-full w-full"
    >
      {node.children.map((child, index) => (
        <LayoutPanel key={child.id} child={child} index={index} split={node} labels={labels}>
          <WorkbenchLayoutRenderer
            node={child}
            canonicalLayout={canonicalLayout}
            totalPanes={totalPanes}
            activeTestId={activeTestId}
            dragged={dragged}
            dropTarget={dropTarget}
            resolvePane={resolvePane}
            getPaneTitle={getPaneTitle}
            getPaneHost={getPaneHost}
            labels={labels}
            focusedViewPaneId={focusedViewPaneId}
            onFocus={onFocus}
            onClose={onClose}
            onSplit={onSplit}
            onToggleFocusedView={onToggleFocusedView}
            onSizesChanged={onSizesChanged}
          />
        </LayoutPanel>
      ))}
    </Group>
  )
}

function LayoutPanel({
  child,
  index,
  split,
  labels,
  children,
}: {
  child: WorkbenchLayoutNode
  index: number
  split: WorkbenchSplitNode
  labels: LayoutLabels
  children: ReactNode
}) {
  return (
    <>
      {index > 0 ? (
        <Separator
          data-testid={`workbench-split-separator-${split.id}-${index}`}
          aria-label={labels.resize}
          className={cn(
            'group/separator relative z-critical shrink-0 bg-border/60 outline-none after:absolute after:inset-[-3px]',
            'data-[separator=hover]:bg-primary/40 data-[separator=active]:bg-primary/60',
            split.orientation === 'horizontal' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'
          )}
        />
      ) : null}
      <Panel
        id={child.id}
        defaultSize={`${split.sizes[index] ?? 100 / split.children.length}%`}
        minSize={
          split.orientation === 'horizontal' ? `${MIN_PANE_WIDTH}px` : `${MIN_PANE_HEIGHT}px`
        }
        className="relative min-h-0 min-w-0 overflow-hidden"
      >
        {children}
      </Panel>
    </>
  )
}

function WorkbenchPaneView({
  pane,
  focused,
  focusedView,
  totalPanes,
  activeTestId,
  dragged,
  dropTarget,
  resolvePane,
  getPaneTitle,
  getPaneHost,
  labels,
  onFocus,
  onClose,
  onSplit,
  onToggleFocusedView,
}: {
  pane: WorkbenchPaneNode
  focused: boolean
  focusedView: boolean
  totalPanes: number
  activeTestId: string
  dragged: boolean
  dropTarget: DropTarget | null
  resolvePane: (paneKey: string) => WorkbenchPaneIdentity | null
  getPaneTitle: (pane: WorkbenchPaneIdentity) => string
  getPaneHost: (paneKey: string) => HTMLDivElement | null
  labels: LayoutLabels
  onFocus: (paneId: string) => void
  onClose: (paneId: string) => void
  onSplit: (paneId: string, direction: WorkbenchSplitDirection) => void
  onToggleFocusedView: (paneId: string) => void
}) {
  const identity = pane.paneKey ? resolvePane(pane.paneKey) : null
  const title = identity ? getPaneTitle(identity) : labels.emptyTitle
  const host = pane.paneKey ? getPaneHost(pane.paneKey) : null
  return (
    <section
      data-testid={`workbench-pane-${pane.id}`}
      data-focused={focused ? 'true' : 'false'}
      className={cn(
        styles.paneGroup,
        'relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background'
      )}
      onPointerDown={() => {
        if (!focused) onFocus(pane.id)
      }}
    >
      {totalPanes > 1 ? (
        <div
          className={cn(
            'flex h-[38px] shrink-0 items-center gap-1 border-b border-border/50 bg-background/95 pl-3',
            focused && 'shadow-[inset_0_2px_0_0_hsl(var(--primary)/0.65)]'
          )}
        >
          <button
            type="button"
            data-testid={`workbench-pane-title-${pane.id}`}
            className="min-w-0 flex-1 truncate text-left text-sm font-medium text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            title={title}
            onClick={() => onFocus(pane.id)}
          >
            {title}
          </button>
          <div
            id={`workbench-pane-header-actions-${pane.id}`}
            data-testid={`workbench-pane-header-actions-${pane.id}`}
            className={cn(
              styles.paneHeaderActions,
              'flex h-full min-w-0 shrink-0 items-center gap-1 overflow-hidden'
            )}
          />
          <TitlebarTooltip label={focusedView ? labels.restoreSplit : labels.focusTask} align="end">
            <button
              type="button"
              data-testid={`workbench-focus-pane-${pane.id}`}
              aria-label={focusedView ? labels.restoreSplit : labels.focusTask}
              aria-pressed={focusedView}
              onClick={() => onToggleFocusedView(pane.id)}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-text-primary/[0.06] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            >
              {focusedView ? <Columns2 className="h-4 w-4" /> : <Focus className="h-4 w-4" />}
            </button>
          </TitlebarTooltip>
          <WorkbenchPaneMenu
            paneId={pane.id}
            canClose={totalPanes > 1}
            labels={labels}
            onSplit={onSplit}
            onClose={onClose}
          />
          <TitlebarTooltip label={labels.closePane} align="end">
            <button
              type="button"
              data-testid={`workbench-close-pane-${pane.id}`}
              aria-label={labels.closePane}
              onClick={() => onClose(pane.id)}
              className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-text-primary/[0.06] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            >
              <X className="h-4 w-4" />
            </button>
          </TitlebarTooltip>
        </div>
      ) : null}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {host ? (
          <div
            data-active-workbench-pane={focused ? 'true' : 'false'}
            data-testid={focused ? activeTestId : undefined}
            className="h-full min-h-0 min-w-0"
          >
            <WorkbenchPaneHost host={host} />
          </div>
        ) : (
          <div
            data-testid={`workbench-empty-pane-${pane.id}`}
            className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center"
          >
            <p className="text-base font-medium text-text-primary">{labels.emptyTitle}</p>
            <p className="max-w-72 text-sm text-text-secondary">{labels.emptyDescription}</p>
          </div>
        )}
      </div>
      {dragged ? (
        <WorkbenchPaneDropTargets
          paneId={pane.id}
          labels={labels}
          activePosition={dropTarget?.paneId === pane.id ? dropTarget.position : null}
        />
      ) : null}
    </section>
  )
}

function WorkbenchPaneMenu({
  paneId,
  canClose,
  labels,
  onSplit,
  onClose,
}: {
  paneId: string
  canClose: boolean
  labels: LayoutLabels
  onSplit: (paneId: string, direction: WorkbenchSplitDirection) => void
  onClose: (paneId: string) => void
}) {
  return (
    <ActionMenu
      ariaLabel={labels.paneMenu}
      testId={`workbench-pane-menu-${paneId}`}
      placement="bottom-end"
      triggerClassName="h-7 w-7 rounded-md"
      items={[
        {
          label: labels.splitLeft,
          icon: PanelLeft,
          testId: `workbench-split-left-${paneId}`,
          onSelect: () => onSplit(paneId, 'left'),
        },
        {
          label: labels.splitRight,
          icon: PanelRight,
          testId: `workbench-split-right-${paneId}`,
          onSelect: () => onSplit(paneId, 'right'),
        },
        {
          label: labels.splitUp,
          icon: PanelTop,
          testId: `workbench-split-up-${paneId}`,
          onSelect: () => onSplit(paneId, 'up'),
        },
        {
          label: labels.splitDown,
          icon: PanelBottom,
          testId: `workbench-split-down-${paneId}`,
          onSelect: () => onSplit(paneId, 'down'),
        },
        {
          label: labels.closePane,
          icon: X,
          testId: `workbench-close-pane-menu-${paneId}`,
          disabled: !canClose,
          onSelect: () => onClose(paneId),
        },
      ]}
    />
  )
}

function WorkbenchPaneDropTargets({
  paneId,
  labels,
  activePosition,
}: {
  paneId: string
  labels: LayoutLabels
  activePosition: DropTarget['position'] | null
}) {
  return (
    <div
      data-testid={`workbench-pane-drop-targets-${paneId}`}
      className="pointer-events-none absolute inset-0 z-critical grid grid-cols-[14%_minmax(0,1fr)_14%] grid-rows-[13%_minmax(0,1fr)_13%] gap-2 bg-background/35 p-3 backdrop-blur-[1px]"
    >
      <DropArea
        paneId={paneId}
        position="up"
        label={labels.dropUp}
        active={activePosition === 'up'}
        className="col-start-2 row-start-1"
      />
      <DropArea
        paneId={paneId}
        position="left"
        label={labels.dropLeft}
        active={activePosition === 'left'}
        className="col-start-1 row-start-2"
      />
      <DropArea
        paneId={paneId}
        position="center"
        label={labels.dropCenter}
        active={activePosition === 'center'}
        className="col-start-2 row-start-2"
      />
      <DropArea
        paneId={paneId}
        position="right"
        label={labels.dropRight}
        active={activePosition === 'right'}
        className="col-start-3 row-start-2"
      />
      <DropArea
        paneId={paneId}
        position="down"
        label={labels.dropDown}
        active={activePosition === 'down'}
        className="col-start-2 row-start-3"
      />
    </div>
  )
}

function DropArea({
  paneId,
  position,
  label,
  active,
  className,
}: {
  paneId: string
  position: DropTarget['position']
  label: string
  active: boolean
  className: string
}) {
  const Icon =
    position === 'left'
      ? PanelLeft
      : position === 'right'
        ? PanelRight
        : position === 'up'
          ? PanelTop
          : position === 'down'
            ? PanelBottom
            : Square
  return (
    <div
      data-testid={`drop:${paneId}:${position}`}
      data-workbench-pane-drop-target="true"
      data-workbench-pane-id={paneId}
      data-workbench-pane-drop-position={position}
      data-over={active ? 'true' : 'false'}
      className={cn(
        'pointer-events-auto flex items-center justify-center gap-2 rounded-lg border border-border/80 text-sm font-medium',
        position === 'center'
          ? 'bg-background/95 text-text-primary shadow-md'
          : 'bg-background/80 text-text-secondary shadow-sm',
        active && 'border-primary bg-primary/20 text-primary ring-2 ring-primary/40 ring-inset',
        className
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span>{label}</span>
    </div>
  )
}
