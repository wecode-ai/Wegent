const PRIORITY_RECENT_DAY_COUNT = 7

export interface DesktopSidebarPrioritySource<Item> {
  key: string
  item: Item
  pinned: boolean
  pinnedOrder: number
  priorityRank: number | null
  recencyAt: number
}

export interface DesktopSidebarPrioritySession {
  activatedAt: number
  pinnedKeys: string[]
  priorityKeys: string[]
  recentRecencyByKey: Map<string, number>
}

export interface DesktopSidebarPriorityRecentGroup<Item> {
  dayStart: number
  items: Item[]
  relativeDay: 'today' | 'yesterday' | 'weekday'
}

export interface DesktopSidebarPriorityView<Item> {
  pinnedItems: Item[]
  priorityItems: Item[]
  recentGroups: DesktopSidebarPriorityRecentGroup<Item>[]
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function getRecentCutoff(activatedAt: number): number {
  const cutoff = new Date(startOfLocalDay(activatedAt))
  cutoff.setDate(cutoff.getDate() - PRIORITY_RECENT_DAY_COUNT + 1)
  return cutoff.getTime()
}

function isRecent(recencyAt: number, activatedAt: number): boolean {
  return recencyAt >= getRecentCutoff(activatedAt)
}

function uniqueKeys(keys: Iterable<string>): string[] {
  return [...new Set(keys)]
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function mapsEqual(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false
  }
  return true
}

function sortPrioritySources<Item>(
  sources: DesktopSidebarPrioritySource<Item>[]
): DesktopSidebarPrioritySource<Item>[] {
  return [...sources].sort(
    (left, right) =>
      (left.priorityRank ?? Number.MAX_SAFE_INTEGER) -
        (right.priorityRank ?? Number.MAX_SAFE_INTEGER) || right.recencyAt - left.recencyAt
  )
}

function sortPinnedSources<Item>(
  sources: DesktopSidebarPrioritySource<Item>[]
): DesktopSidebarPrioritySource<Item>[] {
  return [...sources].sort(
    (left, right) => left.pinnedOrder - right.pinnedOrder || right.recencyAt - left.recencyAt
  )
}

export function createDesktopSidebarPrioritySession<Item>(
  sources: DesktopSidebarPrioritySource<Item>[],
  showPinned: boolean,
  activatedAt = Date.now()
): DesktopSidebarPrioritySession {
  const priorityKeys = sortPrioritySources(
    sources.filter(source => source.priorityRank !== null)
  ).map(source => source.key)
  const priorityKeySet = new Set(priorityKeys)
  const pinnedKeys = sortPinnedSources(sources.filter(source => source.pinned)).map(
    source => source.key
  )
  const recentRecencyByKey = new Map<string, number>()

  for (const source of sources) {
    if (
      source.priorityRank !== null ||
      priorityKeySet.has(source.key) ||
      (showPinned && source.pinned) ||
      !isRecent(source.recencyAt, activatedAt)
    )
      continue
    recentRecencyByKey.set(source.key, source.recencyAt)
  }

  return {
    activatedAt,
    pinnedKeys,
    priorityKeys,
    recentRecencyByKey,
  }
}

export function reconcileDesktopSidebarPrioritySession<Item>(
  session: DesktopSidebarPrioritySession,
  sources: DesktopSidebarPrioritySource<Item>[],
  showPinned: boolean
): DesktopSidebarPrioritySession {
  const sourceByKey = new Map(sources.map(source => [source.key, source]))
  const existingPriorityKeys = session.priorityKeys.filter(key => sourceByKey.has(key))
  const recentRecencyByKey = new Map(
    [...session.recentRecencyByKey].filter(
      ([key, recencyAt]) => sourceByKey.has(key) && isRecent(recencyAt, session.activatedAt)
    )
  )
  const newPriorityKeys = sortPrioritySources(
    sources.filter(
      source =>
        source.priorityRank !== null &&
        !existingPriorityKeys.includes(source.key) &&
        !recentRecencyByKey.has(source.key)
    )
  ).map(source => source.key)
  const priorityKeys = uniqueKeys([...existingPriorityKeys, ...newPriorityKeys])
  const priorityKeySet = new Set(priorityKeys)

  for (const source of sources) {
    if (
      priorityKeySet.has(source.key) ||
      (showPinned && source.pinned) ||
      (source.priorityRank !== null && !recentRecencyByKey.has(source.key)) ||
      !isRecent(source.recencyAt, session.activatedAt)
    )
      continue
    if (!recentRecencyByKey.has(source.key)) {
      recentRecencyByKey.set(source.key, source.recencyAt)
    }
  }

  const existingPinnedKeys = session.pinnedKeys.filter(key => sourceByKey.get(key)?.pinned)
  const newPinnedKeys = sortPinnedSources(
    sources.filter(source => source.pinned && !existingPinnedKeys.includes(source.key))
  ).map(source => source.key)

  const pinnedKeys = uniqueKeys([...existingPinnedKeys, ...newPinnedKeys])
  if (
    arraysEqual(session.pinnedKeys, pinnedKeys) &&
    arraysEqual(session.priorityKeys, priorityKeys) &&
    mapsEqual(session.recentRecencyByKey, recentRecencyByKey)
  )
    return session

  return { ...session, pinnedKeys, priorityKeys, recentRecencyByKey }
}

export function selectDesktopSidebarPriorityView<Item>(
  session: DesktopSidebarPrioritySession,
  sources: DesktopSidebarPrioritySource<Item>[],
  showPinned: boolean
): DesktopSidebarPriorityView<Item> {
  const sourceByKey = new Map(sources.map(source => [source.key, source]))
  const priorityItems = session.priorityKeys.flatMap(key => {
    const source = sourceByKey.get(key)
    return source && (!showPinned || !source.pinned) ? [source.item] : []
  })
  const pinnedItems = showPinned
    ? session.pinnedKeys.flatMap(key => {
        const source = sourceByKey.get(key)
        return source?.pinned ? [source.item] : []
      })
    : []
  const recentEntries = [...session.recentRecencyByKey].flatMap(([key, recencyAt]) => {
    const source = sourceByKey.get(key)
    return source && (!showPinned || !source.pinned) ? [{ item: source.item, recencyAt }] : []
  })
  recentEntries.sort((left, right) => right.recencyAt - left.recencyAt)

  const todayStart = startOfLocalDay(session.activatedAt)
  const yesterday = new Date(todayStart)
  yesterday.setDate(yesterday.getDate() - 1)
  const groups: DesktopSidebarPriorityRecentGroup<Item>[] = []

  for (const entry of recentEntries) {
    const dayStart = startOfLocalDay(entry.recencyAt)
    const existingGroup = groups.at(-1)
    if (existingGroup?.dayStart === dayStart) {
      existingGroup.items.push(entry.item)
      continue
    }
    groups.push({
      dayStart,
      items: [entry.item],
      relativeDay:
        dayStart === todayStart
          ? 'today'
          : dayStart === yesterday.getTime()
            ? 'yesterday'
            : 'weekday',
    })
  }

  return {
    pinnedItems,
    priorityItems,
    recentGroups: groups,
  }
}
