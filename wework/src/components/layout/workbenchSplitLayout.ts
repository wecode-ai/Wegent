export type WorkbenchSplitOrientation = 'horizontal' | 'vertical'
export type WorkbenchSplitDirection = 'left' | 'right' | 'up' | 'down'

export interface WorkbenchSplitNode {
  id: string
  type: 'split'
  orientation: WorkbenchSplitOrientation
  children: WorkbenchLayoutNode[]
  sizes: number[]
}

export interface WorkbenchPaneNode {
  id: string
  type: 'pane'
  paneKey: string | null
}

export type WorkbenchLayoutNode = WorkbenchSplitNode | WorkbenchPaneNode

export interface WorkbenchLayoutState {
  version: 2
  root: WorkbenchLayoutNode
  focusedPaneId: string
}

export interface PersistedWorkbenchLayout {
  version: 2
  layout: WorkbenchLayoutState
}

let layoutIdSequence = 0

function createLayoutId(prefix: 'split' | 'pane') {
  layoutIdSequence += 1
  return `${prefix}-${Date.now().toString(36)}-${layoutIdSequence.toString(36)}`
}

function createPane(paneKey: string | null): WorkbenchPaneNode {
  return {
    id: createLayoutId('pane'),
    type: 'pane',
    paneKey,
  }
}

export function createWorkbenchLayout(paneKey: string): WorkbenchLayoutState {
  const pane = createPane(paneKey)
  return {
    version: 2,
    root: pane,
    focusedPaneId: pane.id,
  }
}

export function collectWorkbenchPaneKeys(node: WorkbenchLayoutNode): string[] {
  if (node.type === 'pane') return node.paneKey ? [node.paneKey] : []
  return node.children.flatMap(collectWorkbenchPaneKeys)
}

export function collectWorkbenchPanes(node: WorkbenchLayoutNode): WorkbenchPaneNode[] {
  if (node.type === 'pane') return [node]
  return node.children.flatMap(collectWorkbenchPanes)
}

export function findWorkbenchPane(
  node: WorkbenchLayoutNode,
  paneId: string
): WorkbenchPaneNode | null {
  if (node.type === 'pane') return node.id === paneId ? node : null
  for (const child of node.children) {
    const match = findWorkbenchPane(child, paneId)
    if (match) return match
  }
  return null
}

export function focusWorkbenchPane(
  state: WorkbenchLayoutState,
  paneId: string
): WorkbenchLayoutState {
  return findWorkbenchPane(state.root, paneId) ? { ...state, focusedPaneId: paneId } : state
}

export function focusWorkbenchTask(
  state: WorkbenchLayoutState,
  paneKey: string
): WorkbenchLayoutState | null {
  const pane = collectWorkbenchPanes(state.root).find(candidate => candidate.paneKey === paneKey)
  return pane ? { ...state, focusedPaneId: pane.id } : null
}

export function openWorkbenchPane(
  state: WorkbenchLayoutState,
  paneKey: string
): WorkbenchLayoutState {
  const existing = focusWorkbenchTask(state, paneKey)
  if (existing) return existing

  const panes = collectWorkbenchPanes(state.root)
  const target = panes.find(pane => pane.id === state.focusedPaneId) ?? panes[0]
  if (!target) return createWorkbenchLayout(paneKey)
  return {
    ...state,
    root: updatePane(state.root, target.id, pane => ({ ...pane, paneKey })),
    focusedPaneId: target.id,
  }
}

export function splitWorkbenchPane(
  state: WorkbenchLayoutState,
  paneId: string,
  direction: WorkbenchSplitDirection
): WorkbenchLayoutState {
  if (!findWorkbenchPane(state.root, paneId)) return state
  return insertWorkbenchPane(state, paneId, direction, createPane(null))
}

export function placeWorkbenchTask(
  state: WorkbenchLayoutState,
  paneKey: string,
  targetPaneId: string,
  position: 'center' | WorkbenchSplitDirection
): WorkbenchLayoutState {
  const target = findWorkbenchPane(state.root, targetPaneId)
  if (!target) return state

  const source = collectWorkbenchPanes(state.root).find(pane => pane.paneKey === paneKey)
  if (source?.id === targetPaneId && position !== 'center') return state
  if (position === 'center') {
    if (source?.id === targetPaneId) return focusWorkbenchPane(state, targetPaneId)

    let root = state.root
    if (source) {
      root = removePane(root, source.id) ?? createPane(null)
    }
    const remainingTarget = findWorkbenchPane(root, targetPaneId)
    if (!remainingTarget) return state
    root = updatePane(root, targetPaneId, pane => ({ ...pane, paneKey }))
    return {
      ...state,
      root,
      focusedPaneId: targetPaneId,
    }
  }

  let root = state.root
  if (source) {
    root = removePane(root, source.id) ?? createPane(null)
  }
  if (!findWorkbenchPane(root, targetPaneId)) return state
  return insertWorkbenchPane(
    {
      ...state,
      root,
      focusedPaneId: targetPaneId,
    },
    targetPaneId,
    position,
    createPane(paneKey)
  )
}

export function closeWorkbenchPane(
  state: WorkbenchLayoutState,
  paneId: string
): WorkbenchLayoutState {
  const panes = collectWorkbenchPanes(state.root)
  if (!panes.some(pane => pane.id === paneId)) return state
  if (panes.length === 1) {
    return {
      ...state,
      root: updatePane(state.root, paneId, pane => ({ ...pane, paneKey: null })),
      focusedPaneId: paneId,
    }
  }

  const root = removePane(state.root, paneId)
  if (!root) return state
  const remaining = collectWorkbenchPanes(root)
  const nextFocused =
    remaining.find(pane => pane.id === state.focusedPaneId) ??
    remaining.find(pane => pane.paneKey) ??
    remaining[0]
  return {
    ...state,
    root,
    focusedPaneId: nextFocused.id,
  }
}

export function updateWorkbenchSplitSizes(
  state: WorkbenchLayoutState,
  splitId: string,
  layout: Record<string, number>
): WorkbenchLayoutState {
  return {
    ...state,
    root: mapLayoutNode(state.root, node => {
      if (node.type !== 'split' || node.id !== splitId) return node
      return {
        ...node,
        sizes: normalizeSizes(
          node.children.map(child => layout[child.id] ?? 100 / node.children.length)
        ),
      }
    }),
  }
}

export function pruneWorkbenchLayout(
  state: WorkbenchLayoutState,
  validPaneKeys: ReadonlySet<string>
): WorkbenchLayoutState | null {
  const root = pruneNode(state.root, validPaneKeys)
  if (!root) return null
  const panes = collectWorkbenchPanes(root)
  const focused =
    panes.find(pane => pane.id === state.focusedPaneId) ??
    panes.find(pane => pane.paneKey) ??
    panes[0]
  return {
    ...state,
    root,
    focusedPaneId: focused.id,
  }
}

export function parsePersistedWorkbenchLayout(value: string | null): WorkbenchLayoutState | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as PersistedWorkbenchLayout
    if (parsed.version !== 2 || !isLayoutState(parsed.layout)) return null
    return parsed.layout
  } catch {
    return null
  }
}

export function serializeWorkbenchLayout(state: WorkbenchLayoutState): string {
  return JSON.stringify({ version: 2, layout: state } satisfies PersistedWorkbenchLayout)
}

function insertWorkbenchPane(
  state: WorkbenchLayoutState,
  paneId: string,
  direction: WorkbenchSplitDirection,
  newPane: WorkbenchPaneNode
): WorkbenchLayoutState {
  const orientation: WorkbenchSplitOrientation =
    direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical'
  const before = direction === 'left' || direction === 'up'
  return {
    ...state,
    root: splitNodeAtPane(state.root, paneId, newPane, orientation, before),
    focusedPaneId: newPane.id,
  }
}

function splitNodeAtPane(
  node: WorkbenchLayoutNode,
  paneId: string,
  newPane: WorkbenchPaneNode,
  orientation: WorkbenchSplitOrientation,
  before: boolean
): WorkbenchLayoutNode {
  if (node.type === 'pane') {
    if (node.id !== paneId) return node
    return {
      id: createLayoutId('split'),
      type: 'split',
      orientation,
      children: before ? [newPane, node] : [node, newPane],
      sizes: [50, 50],
    }
  }

  const targetIndex = node.children.findIndex(child => containsPane(child, paneId))
  if (targetIndex < 0) return node
  if (node.orientation === orientation) {
    const children = [...node.children]
    const sizes = [...node.sizes]
    const insertionIndex = before ? targetIndex : targetIndex + 1
    const targetSize = sizes[targetIndex] ?? 100 / children.length
    children.splice(insertionIndex, 0, newPane)
    sizes[targetIndex] = targetSize / 2
    sizes.splice(insertionIndex, 0, targetSize / 2)
    return { ...node, children, sizes: normalizeSizes(sizes) }
  }
  return {
    ...node,
    children: node.children.map(child =>
      containsPane(child, paneId)
        ? splitNodeAtPane(child, paneId, newPane, orientation, before)
        : child
    ),
  }
}

function removePane(node: WorkbenchLayoutNode, paneId: string): WorkbenchLayoutNode | null {
  if (node.type === 'pane') return node.id === paneId ? null : node
  const retained = node.children
    .map((child, index) => ({
      child: removePane(child, paneId),
      size: node.sizes[index] ?? 100 / node.children.length,
    }))
    .filter((entry): entry is { child: WorkbenchLayoutNode; size: number } => entry.child !== null)
  if (retained.length === 0) return null
  if (retained.length === 1) return retained[0].child
  return {
    ...node,
    children: retained.map(entry => entry.child),
    sizes: normalizeSizes(retained.map(entry => entry.size)),
  }
}

function pruneNode(
  node: WorkbenchLayoutNode,
  validPaneKeys: ReadonlySet<string>
): WorkbenchLayoutNode | null {
  if (node.type === 'pane') {
    if (!node.paneKey || !node.paneKey.startsWith('runtime:') || validPaneKeys.has(node.paneKey)) {
      return node
    }
    return null
  }
  const retained = node.children
    .map((child, index) => ({
      child: pruneNode(child, validPaneKeys),
      size: node.sizes[index] ?? 100 / node.children.length,
    }))
    .filter((entry): entry is { child: WorkbenchLayoutNode; size: number } => entry.child !== null)
  if (retained.length === 0) return null
  if (retained.length === 1) return retained[0].child
  return {
    ...node,
    children: retained.map(entry => entry.child),
    sizes: normalizeSizes(retained.map(entry => entry.size)),
  }
}

function updatePane(
  node: WorkbenchLayoutNode,
  paneId: string,
  update: (pane: WorkbenchPaneNode) => WorkbenchPaneNode
): WorkbenchLayoutNode {
  if (node.type === 'pane') return node.id === paneId ? update(node) : node
  return {
    ...node,
    children: node.children.map(child => updatePane(child, paneId, update)),
  }
}

function mapLayoutNode(
  node: WorkbenchLayoutNode,
  update: (node: WorkbenchLayoutNode) => WorkbenchLayoutNode
): WorkbenchLayoutNode {
  const mapped =
    node.type === 'split'
      ? { ...node, children: node.children.map(child => mapLayoutNode(child, update)) }
      : node
  return update(mapped)
}

function containsPane(node: WorkbenchLayoutNode, paneId: string): boolean {
  if (node.type === 'pane') return node.id === paneId
  return node.children.some(child => containsPane(child, paneId))
}

function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + Math.max(0, size), 0)
  if (total <= 0) return sizes.map(() => 100 / sizes.length)
  return sizes.map(size => (Math.max(0, size) / total) * 100)
}

function isLayoutState(value: unknown): value is WorkbenchLayoutState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<WorkbenchLayoutState>
  return state.version === 2 && typeof state.focusedPaneId === 'string' && isLayoutNode(state.root)
}

function isLayoutNode(value: unknown): value is WorkbenchLayoutNode {
  if (!value || typeof value !== 'object') return false
  const node = value as Partial<WorkbenchLayoutNode>
  if (typeof node.id !== 'string') return false
  if (node.type === 'pane') {
    return typeof node.paneKey === 'string' || node.paneKey === null
  }
  if (node.type !== 'split') return false
  return (
    (node.orientation === 'horizontal' || node.orientation === 'vertical') &&
    Array.isArray(node.children) &&
    node.children.length >= 2 &&
    node.children.every(isLayoutNode) &&
    Array.isArray(node.sizes) &&
    node.sizes.length === node.children.length &&
    node.sizes.every(size => typeof size === 'number' && Number.isFinite(size))
  )
}
