import { useSyncExternalStore } from 'react'

export type AutomationCanvasSelection =
  | { type: 'trigger' }
  | { type: 'step'; id: string }
  | {
      type: 'dagStage'
      stepId: string
      stageId: string
    }
  | {
      type: 'loopBody'
      loopId: string
      bodyId: string
    }
  | { type: 'none' }

let eventBus: AutomationCanvasEventBus | null = null
const subscribers = new Set<() => void>()

export interface AutomationCanvasEventBus {
  selectNode: (selection: AutomationCanvasSelection) => void
}

function emitChange() {
  subscribers.forEach(subscriber => subscriber())
}

function subscribe(subscriber: () => void) {
  subscribers.add(subscriber)
  return () => subscribers.delete(subscriber)
}

export function useCanvasEventBus<T>(selector: (eventBus: AutomationCanvasEventBus) => T): T {
  const currentEventBus = useSyncExternalStore(
    subscribe,
    () => eventBus,
    () => eventBus
  )
  if (!currentEventBus) return null as unknown as T
  return selector(currentEventBus)
}

export function setCanvasEventBus(nextEventBus: AutomationCanvasEventBus) {
  eventBus = nextEventBus
  emitChange()
}

export function canvasNodeIdToSelection(nodeId: string): AutomationCanvasSelection {
  if (nodeId === 'trigger') return { type: 'trigger' }
  if (nodeId.startsWith('dag:')) {
    const [, stepId, stageId] = nodeId.split(':')
    return { type: 'dagStage', stepId, stageId }
  }
  if (nodeId.startsWith('loop:')) {
    const [, loopId, bodyId] = nodeId.split(':')
    return { type: 'loopBody', loopId, bodyId }
  }
  return { type: 'step', id: nodeId }
}
