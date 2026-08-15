import {
  closeWorkbenchPane,
  collectWorkbenchPaneKeys,
  collectWorkbenchPanes,
  createWorkbenchLayout,
  findWorkbenchPane,
  focusWorkbenchPane,
  focusWorkbenchTask,
  parsePersistedWorkbenchLayout,
  placeWorkbenchTask,
  pruneWorkbenchLayout,
  splitWorkbenchPane,
  updateWorkbenchSplitSizes,
  type WorkbenchLayoutState,
  type WorkbenchSplitDirection,
} from './workbenchSplitLayout'

export interface WorkbenchSplitGroup {
  id: string
  displayNumber: number
  draft: boolean
  layout: WorkbenchLayoutState
}

export type WorkbenchSplitView =
  | { type: 'single'; layout: WorkbenchLayoutState }
  | { type: 'group'; groupId: string }

export interface WorkbenchSplitGroupsState {
  version: 3
  groups: WorkbenchSplitGroup[]
  activeView: WorkbenchSplitView
}

interface PersistedWorkbenchSplitGroups {
  version: 3
  state: WorkbenchSplitGroupsState
}

export interface WorkbenchSplitGroupMembership {
  groupId: string
  displayNumber: number
  active: boolean
  focused: boolean
}

function createGroupId() {
  return `group-${crypto.randomUUID()}`
}

function runtimePaneKeys(layout: WorkbenchLayoutState): string[] {
  return collectWorkbenchPaneKeys(layout.root).filter(key => key.startsWith('runtime:'))
}

function nextDisplayNumber(groups: WorkbenchSplitGroup[]): number {
  const used = new Set(groups.map(group => group.displayNumber))
  let candidate = 1
  while (used.has(candidate)) candidate += 1
  return candidate
}

function activeGroup(state: WorkbenchSplitGroupsState): WorkbenchSplitGroup | null {
  if (state.activeView.type !== 'group') return null
  const groupId = state.activeView.groupId
  return state.groups.find(group => group.id === groupId) ?? null
}

function normalizeActiveView(
  state: WorkbenchSplitGroupsState,
  fallbackPaneKey: string
): WorkbenchSplitGroupsState {
  if (state.activeView.type === 'single') return state
  const groupId = state.activeView.groupId
  if (state.groups.some(group => group.id === groupId)) return state
  return {
    ...state,
    activeView: { type: 'single', layout: createWorkbenchLayout(fallbackPaneKey) },
  }
}

function discardInactiveDraftGroups(state: WorkbenchSplitGroupsState): WorkbenchSplitGroupsState {
  const activeGroupId = state.activeView.type === 'group' ? state.activeView.groupId : null
  const groups = state.groups.filter(group => !group.draft || group.id === activeGroupId)
  return groups.length === state.groups.length ? state : { ...state, groups }
}

function updateGroup(
  state: WorkbenchSplitGroupsState,
  groupId: string,
  update: (group: WorkbenchSplitGroup) => WorkbenchSplitGroup
): WorkbenchSplitGroupsState {
  let changed = false
  const groups = state.groups.map(group => {
    if (group.id !== groupId) return group
    const next = update(group)
    changed = changed || next !== group
    return next
  })
  if (!changed) return state
  return {
    ...state,
    groups,
  }
}

function removeGroup(
  state: WorkbenchSplitGroupsState,
  groupId: string,
  fallbackPaneKey: string
): WorkbenchSplitGroupsState {
  const group = state.groups.find(candidate => candidate.id === groupId)
  const groups = state.groups.filter(candidate => candidate.id !== groupId)
  if (state.activeView.type !== 'group' || state.activeView.groupId !== groupId) {
    return { ...state, groups }
  }
  const remainingPaneKey = group && collectWorkbenchPaneKeys(group.layout.root).find(Boolean)
  return {
    ...state,
    groups,
    activeView: {
      type: 'single',
      layout: createWorkbenchLayout(remainingPaneKey ?? fallbackPaneKey),
    },
  }
}

function normalizeGroup(
  state: WorkbenchSplitGroupsState,
  groupId: string,
  fallbackPaneKey: string
): WorkbenchSplitGroupsState {
  const group = state.groups.find(candidate => candidate.id === groupId)
  if (!group) return state
  const panes = collectWorkbenchPanes(group.layout.root)
  const memberKeys = runtimePaneKeys(group.layout)
  if (panes.length <= 1 || (!group.draft && memberKeys.length < 2)) {
    return removeGroup(state, groupId, fallbackPaneKey)
  }
  if (group.draft && memberKeys.length >= 2) {
    return updateGroup(state, groupId, current => ({ ...current, draft: false }))
  }
  return state
}

function detachPaneKey(
  state: WorkbenchSplitGroupsState,
  paneKey: string,
  exceptGroupId: string | null,
  fallbackPaneKey: string
): WorkbenchSplitGroupsState {
  let next = state
  for (const group of state.groups) {
    if (group.id === exceptGroupId) continue
    const pane = collectWorkbenchPanes(group.layout.root).find(node => node.paneKey === paneKey)
    if (!pane) continue
    next = updateGroup(next, group.id, current => ({
      ...current,
      layout: closeWorkbenchPane(current.layout, pane.id),
    }))
    next = normalizeGroup(next, group.id, fallbackPaneKey)
  }
  return next
}

function focusedPaneCanAcceptTask(layout: WorkbenchLayoutState): boolean {
  const focused = findWorkbenchPane(layout.root, layout.focusedPaneId)
  return !focused?.paneKey || focused.paneKey.startsWith('blank:')
}

export function createWorkbenchSplitGroupsState(paneKey: string): WorkbenchSplitGroupsState {
  return {
    version: 3,
    groups: [],
    activeView: { type: 'single', layout: createWorkbenchLayout(paneKey) },
  }
}

export function getActiveWorkbenchLayout(state: WorkbenchSplitGroupsState): WorkbenchLayoutState {
  if (state.activeView.type === 'single') return state.activeView.layout
  const groupId = state.activeView.groupId
  return (
    state.groups.find(group => group.id === groupId)?.layout ?? createWorkbenchLayout('blank:0')
  )
}

export function getWorkbenchSplitGroupMemberships(
  state: WorkbenchSplitGroupsState
): Record<string, WorkbenchSplitGroupMembership> {
  const memberships: Record<string, WorkbenchSplitGroupMembership> = {}
  for (const group of state.groups) {
    const active = state.activeView.type === 'group' && state.activeView.groupId === group.id
    const focusedPane = findWorkbenchPane(group.layout.root, group.layout.focusedPaneId)
    for (const paneKey of runtimePaneKeys(group.layout)) {
      memberships[paneKey] = {
        groupId: group.id,
        displayNumber: group.displayNumber,
        active,
        focused: active && focusedPane?.paneKey === paneKey,
      }
    }
  }
  return memberships
}

export function activateWorkbenchPane(
  state: WorkbenchSplitGroupsState,
  paneKey: string
): WorkbenchSplitGroupsState {
  const owningGroup = state.groups.find(group =>
    collectWorkbenchPaneKeys(group.layout.root).includes(paneKey)
  )
  if (owningGroup) {
    const layout = focusWorkbenchTask(owningGroup.layout, paneKey) ?? owningGroup.layout
    if (
      layout === owningGroup.layout &&
      state.activeView.type === 'group' &&
      state.activeView.groupId === owningGroup.id
    ) {
      return discardInactiveDraftGroups(state)
    }
    return discardInactiveDraftGroups({
      ...updateGroup(state, owningGroup.id, group => ({ ...group, layout })),
      activeView: { type: 'group', groupId: owningGroup.id },
    })
  }

  const currentGroup = activeGroup(state)
  if (currentGroup && focusedPaneCanAcceptTask(currentGroup.layout)) {
    let next = detachPaneKey(state, paneKey, currentGroup.id, paneKey)
    next = updateGroup(next, currentGroup.id, group => ({
      ...group,
      layout: placeWorkbenchTask(group.layout, paneKey, group.layout.focusedPaneId, 'center'),
    }))
    return normalizeGroup(next, currentGroup.id, paneKey)
  }

  const layout =
    state.activeView.type === 'single'
      ? placeWorkbenchTask(
          state.activeView.layout,
          paneKey,
          state.activeView.layout.focusedPaneId,
          'center'
        )
      : createWorkbenchLayout(paneKey)
  return discardInactiveDraftGroups({
    ...state,
    activeView: { type: 'single', layout },
  })
}

export function splitActiveWorkbenchPane(
  state: WorkbenchSplitGroupsState,
  paneId: string,
  direction: WorkbenchSplitDirection
): WorkbenchSplitGroupsState {
  if (state.activeView.type === 'group') {
    return updateGroup(state, state.activeView.groupId, group => ({
      ...group,
      layout: splitWorkbenchPane(group.layout, paneId, direction),
    }))
  }
  const group: WorkbenchSplitGroup = {
    id: createGroupId(),
    displayNumber: nextDisplayNumber(state.groups),
    draft: runtimePaneKeys(state.activeView.layout).length < 2,
    layout: splitWorkbenchPane(state.activeView.layout, paneId, direction),
  }
  return {
    ...state,
    groups: [...state.groups, group],
    activeView: { type: 'group', groupId: group.id },
  }
}

export function focusActiveWorkbenchPane(
  state: WorkbenchSplitGroupsState,
  paneId: string
): WorkbenchSplitGroupsState {
  if (state.activeView.type === 'single') {
    const layout = focusWorkbenchPane(state.activeView.layout, paneId)
    if (layout === state.activeView.layout) return state
    return {
      ...state,
      activeView: {
        type: 'single',
        layout,
      },
    }
  }
  return updateGroup(state, state.activeView.groupId, group => {
    const layout = focusWorkbenchPane(group.layout, paneId)
    return layout === group.layout ? group : { ...group, layout }
  })
}

export function closeActiveWorkbenchPane(
  state: WorkbenchSplitGroupsState,
  paneId: string,
  fallbackPaneKey: string
): WorkbenchSplitGroupsState {
  if (state.activeView.type === 'single') return state
  const groupId = state.activeView.groupId
  const next = updateGroup(state, groupId, group => ({
    ...group,
    layout: closeWorkbenchPane(group.layout, paneId),
  }))
  return normalizeGroup(next, groupId, fallbackPaneKey)
}

export function placeActiveWorkbenchTask(
  state: WorkbenchSplitGroupsState,
  paneKey: string,
  targetPaneId: string,
  position: 'center' | WorkbenchSplitDirection,
  fallbackPaneKey: string
): WorkbenchSplitGroupsState {
  if (state.activeView.type === 'single') {
    let next = detachPaneKey(state, paneKey, null, fallbackPaneKey)
    if (next.activeView.type !== 'single') return next
    const layout = placeWorkbenchTask(next.activeView.layout, paneKey, targetPaneId, position)
    if (position === 'center') {
      return discardInactiveDraftGroups({
        ...next,
        activeView: { type: 'single', layout },
      })
    }
    const group: WorkbenchSplitGroup = {
      id: createGroupId(),
      displayNumber: nextDisplayNumber(next.groups),
      draft: runtimePaneKeys(layout).length < 2,
      layout,
    }
    next = {
      ...next,
      groups: [...next.groups, group],
      activeView: { type: 'group', groupId: group.id },
    }
    return normalizeGroup(next, group.id, fallbackPaneKey)
  }
  const groupId = state.activeView.groupId
  let next = detachPaneKey(state, paneKey, groupId, fallbackPaneKey)
  next = updateGroup(next, groupId, group => ({
    ...group,
    layout: placeWorkbenchTask(group.layout, paneKey, targetPaneId, position),
  }))
  return normalizeGroup(next, groupId, fallbackPaneKey)
}

export function updateActiveWorkbenchSplitSizes(
  state: WorkbenchSplitGroupsState,
  splitId: string,
  sizes: Record<string, number>
): WorkbenchSplitGroupsState {
  if (state.activeView.type !== 'group') return state
  return updateGroup(state, state.activeView.groupId, group => ({
    ...group,
    layout: updateWorkbenchSplitSizes(group.layout, splitId, sizes),
  }))
}

export function pruneWorkbenchSplitGroups(
  state: WorkbenchSplitGroupsState,
  validPaneKeys: ReadonlySet<string>,
  fallbackPaneKey: string
): WorkbenchSplitGroupsState {
  let next = state
  for (const group of state.groups) {
    const layout = pruneWorkbenchLayout(group.layout, validPaneKeys)
    if (!layout) {
      next = removeGroup(next, group.id, fallbackPaneKey)
      continue
    }
    if (layout !== group.layout) {
      next = updateGroup(next, group.id, current => ({ ...current, layout }))
    }
    next = normalizeGroup(next, group.id, fallbackPaneKey)
  }
  if (next.activeView.type === 'single') {
    const layout =
      pruneWorkbenchLayout(next.activeView.layout, validPaneKeys) ??
      createWorkbenchLayout(fallbackPaneKey)
    if (layout !== next.activeView.layout) {
      next = { ...next, activeView: { type: 'single', layout } }
    }
  }
  return normalizeActiveView(next, fallbackPaneKey)
}

export function parsePersistedWorkbenchSplitGroups(
  value: string | null,
  fallbackPaneKey = 'blank:0'
): WorkbenchSplitGroupsState | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as PersistedWorkbenchSplitGroups
    if (parsed.version !== 3 || parsed.state?.version !== 3) return null
    if (!Array.isArray(parsed.state.groups)) return null
    const groups = parsed.state.groups.flatMap(group => {
      if (
        !group ||
        typeof group.id !== 'string' ||
        !Number.isInteger(group.displayNumber) ||
        group.displayNumber < 1 ||
        typeof group.draft !== 'boolean'
      ) {
        return []
      }
      const layout = parsePersistedWorkbenchLayout(
        JSON.stringify({ version: 2, layout: group.layout })
      )
      return layout ? [{ ...group, layout }] : []
    })
    const activeView = parsed.state.activeView
    if (activeView?.type === 'group' && typeof activeView.groupId === 'string') {
      return normalizeActiveView(
        {
          version: 3,
          groups,
          activeView: { type: 'group', groupId: activeView.groupId },
        },
        fallbackPaneKey
      )
    }
    if (activeView?.type === 'single') {
      const layout = parsePersistedWorkbenchLayout(
        JSON.stringify({ version: 2, layout: activeView.layout })
      )
      if (layout) return { version: 3, groups, activeView: { type: 'single', layout } }
    }
    return null
  } catch {
    return null
  }
}

export function migratePersistedWorkbenchSplitLayout(
  value: string | null,
  fallbackPaneKey: string
): WorkbenchSplitGroupsState | null {
  const layout = parsePersistedWorkbenchLayout(value)
  if (!layout) return null
  if (collectWorkbenchPanes(layout.root).length <= 1) {
    return {
      version: 3,
      groups: [],
      activeView: { type: 'single', layout },
    }
  }
  const group: WorkbenchSplitGroup = {
    id: createGroupId(),
    displayNumber: 1,
    draft: runtimePaneKeys(layout).length < 2,
    layout,
  }
  return normalizeActiveView(
    {
      version: 3,
      groups: [group],
      activeView: { type: 'group', groupId: group.id },
    },
    fallbackPaneKey
  )
}

export function serializeWorkbenchSplitGroups(state: WorkbenchSplitGroupsState): string {
  return JSON.stringify({ version: 3, state } satisfies PersistedWorkbenchSplitGroups)
}
