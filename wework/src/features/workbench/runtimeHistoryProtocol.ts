import type { ExecutorRuntimeClient } from '@/api/executorAccess'
import type {
  DeviceInfo,
  RuntimeHistoryCapability,
  RuntimeHistoryTurn,
  RuntimeTaskAddress,
  RuntimeTranscriptResponse,
  RuntimeTranscriptTurnItem,
} from '@/types/api'
import type { RuntimePaneTranscriptLoadOptions } from '@/types/workbench'

const DEFAULT_TURN_PAGE_SIZE = 5
const DEFAULT_ITEM_PAGE_SIZE = 20

export function runtimeHistoryV2Capability(
  device: DeviceInfo | null | undefined
): RuntimeHistoryCapability | null {
  const capability = device?.runtime_features?.runtimeHistory
  return capability?.schemaVersions.includes(2) ? capability : null
}

export async function loadRuntimeHistoryV2(
  runtime: ExecutorRuntimeClient,
  address: RuntimeTaskAddress,
  capability: RuntimeHistoryCapability,
  options: RuntimePaneTranscriptLoadOptions
): Promise<RuntimeTranscriptResponse> {
  const turnPage = await runtime.listRuntimeHistoryTurns({
    ...address,
    limit: Math.min(
      options.limit ?? capability.defaultTurnPageSize ?? DEFAULT_TURN_PAGE_SIZE,
      capability.defaultTurnPageSize ?? DEFAULT_TURN_PAGE_SIZE,
      capability.maxTurnPageSize
    ),
    beforeCursor: options.beforeCursor,
    afterCursor: options.afterCursor,
    refresh: options.refresh,
  })
  const turns = await Promise.all(
    turnPage.turns.map(turn =>
      hydrateRuntimeHistoryTurn(
        runtime,
        address,
        turn,
        capability.defaultItemPageSize ?? DEFAULT_ITEM_PAGE_SIZE
      )
    )
  )
  return {
    taskId: turnPage.taskId,
    workspacePath: turnPage.workspacePath,
    runtime: turnPage.runtime,
    running: turnPage.running,
    messages: [],
    turns,
    turnNavigation: turnPage.turnNavigation ?? [],
    contextUsage: turnPage.contextUsage ?? null,
    rangeStart: turnPage.rangeStart ?? null,
    rangeEnd: turnPage.rangeEnd ?? null,
    hasMoreBefore: Boolean(turnPage.hasMoreBefore),
    beforeCursor: turnPage.beforeCursor ?? null,
    hasMoreAfter: Boolean(turnPage.hasMoreAfter),
    afterCursor: turnPage.afterCursor ?? null,
  }
}

async function hydrateRuntimeHistoryTurn(
  runtime: ExecutorRuntimeClient,
  address: RuntimeTaskAddress,
  turn: RuntimeHistoryTurn,
  itemPageSize: number
): Promise<RuntimeHistoryTurn> {
  let cursor: string | null = null
  const seenCursors = new Set<string>()
  let items: RuntimeTranscriptTurnItem[] = []

  do {
    if (cursor && !seenCursors.add(cursor)) {
      throw new Error(`Runtime history item cursor repeated for turn ${turn.id}`)
    }
    const page = await runtime.listRuntimeHistoryItems({
      ...address,
      turnId: turn.id,
      cursor,
      limit: itemPageSize,
    })
    items = mergeRuntimeHistoryItems(items, page.items)
    cursor = page.hasMore ? (page.nextCursor ?? null) : null
    if (page.hasMore && !cursor) {
      throw new Error(`Runtime history item page omitted its cursor for turn ${turn.id}`)
    }
  } while (cursor)

  return {
    ...turn,
    items,
    itemsView: 'full',
  }
}

function mergeRuntimeHistoryItems(
  current: RuntimeTranscriptTurnItem[],
  incoming: RuntimeTranscriptTurnItem[]
): RuntimeTranscriptTurnItem[] {
  const merged = [...current]
  for (const item of incoming) {
    const index = merged.findIndex(existing => existing.id === item.id)
    if (index < 0) {
      merged.push(item)
      continue
    }
    const existing = merged[index]
    merged[index] =
      existing.type === 'block' && item.type === 'block'
        ? { ...item, block: { ...existing.block, ...item.block } }
        : item
  }
  return merged
}
