export const WEWORK_DSH_SLOTS = {
  action: 'wework.action',
  app: 'wework.app',
  boardCardStatus: 'wework.board.card.status',
  environmentSection: 'wework.environment.section',
  route: 'wework.route',
  settingsPage: 'wework.settings.page',
  sidebarNavigation: 'wework.sidebar.navigation',
  shellAfter: 'wework.shell.after',
  shellBefore: 'wework.shell.before',
  shellOverlay: 'wework.shell.overlay',
  sourceControlProvider: 'wework.source-control.provider',
  taskStatus: 'wework.task.status',
  workspaceSidebarTab: 'wework.workspace.sidebar.tab',
  workspaceTab: 'wework.workspace.tab',
} as const

export type WeworkDshSlotName = (typeof WEWORK_DSH_SLOTS)[keyof typeof WEWORK_DSH_SLOTS]

export interface WeworkDshSlotEntry {
  id: string
  label?: string
  order?: number
  [key: string]: unknown
}

export interface WeworkDshSlotMount {
  update(props: object): void
  dispose(): void
}

interface WeworkDshUiRuntime {
  getEntries(slotName: WeworkDshSlotName): readonly WeworkDshSlotEntry[]
  subscribe(slotName: WeworkDshSlotName, listener: () => void): () => void
  attach(
    slotName: WeworkDshSlotName,
    id: string | undefined,
    container: HTMLElement,
    props: object
  ): WeworkDshSlotMount
}

const EMPTY_ENTRIES: readonly WeworkDshSlotEntry[] = []
const entrySnapshots = new Map<WeworkDshSlotName, readonly WeworkDshSlotEntry[]>()

export function getDshSlotEntries<T extends WeworkDshSlotEntry>(
  slotName: WeworkDshSlotName
): readonly T[] {
  const entries = window.__WEWORK_DSH_UI__?.getEntries(slotName) ?? EMPTY_ENTRIES
  const previous = entrySnapshots.get(slotName)
  if (
    previous &&
    previous.length === entries.length &&
    previous.every((entry, index) => entry === entries[index])
  ) {
    return previous as readonly T[]
  }
  entrySnapshots.set(slotName, entries)
  return entries as readonly T[]
}

export function subscribeDshSlot(slotName: WeworkDshSlotName, listener: () => void): () => void {
  return window.__WEWORK_DSH_UI__?.subscribe(slotName, listener) ?? (() => {})
}

export function attachDshSlot(
  slotName: WeworkDshSlotName,
  id: string | undefined,
  container: HTMLElement,
  props: object
): WeworkDshSlotMount | null {
  return window.__WEWORK_DSH_UI__?.attach(slotName, id, container, props) ?? null
}

declare global {
  interface Window {
    __WEWORK_DSH_UI__?: WeworkDshUiRuntime
  }
}
