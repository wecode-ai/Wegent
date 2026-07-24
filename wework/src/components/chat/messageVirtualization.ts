export interface MessageVirtualEntry {
  key: string
  estimatedHeightPx: number
}

export interface MessageVirtualLayout {
  bottomOffsetsPx: number[]
  heightsPx: number[]
  topOffsetsPx: number[]
  totalHeightPx: number
  indexByKey: Map<string, number>
  keys: string[]
}

export interface MessageVirtualRange {
  startIndex: number
  endIndex: number
}

export function buildMessageVirtualLayout({
  entries,
  gapPx,
  measuredHeightsByKey,
  paddingBottomPx,
  paddingTopPx,
}: {
  entries: MessageVirtualEntry[]
  gapPx: number
  measuredHeightsByKey: Readonly<Record<string, number>>
  paddingBottomPx: number
  paddingTopPx: number
}): MessageVirtualLayout {
  const heightsPx: number[] = []
  const topOffsetsPx: number[] = []
  const indexByKey = new Map<string, number>()
  const keys: string[] = []
  let totalHeightPx = paddingTopPx

  entries.forEach((entry, index) => {
    const heightPx = measuredHeightsByKey[entry.key] ?? entry.estimatedHeightPx
    indexByKey.set(entry.key, index)
    keys.push(entry.key)
    topOffsetsPx.push(totalHeightPx)
    heightsPx.push(heightPx)
    totalHeightPx += heightPx
    if (index < entries.length - 1) totalHeightPx += gapPx
  })
  totalHeightPx += paddingBottomPx

  return {
    bottomOffsetsPx: topOffsetsPx.map(
      (topOffsetPx, index) => totalHeightPx - topOffsetPx - (heightsPx[index] ?? 0)
    ),
    heightsPx,
    topOffsetsPx,
    totalHeightPx,
    indexByKey,
    keys,
  }
}

export function getMessageVirtualRange({
  distanceFromBottomPx,
  layout,
  overscanCount,
  viewportHeightPx,
}: {
  distanceFromBottomPx: number
  layout: MessageVirtualLayout
  overscanCount: number
  viewportHeightPx: number
}): MessageVirtualRange {
  if (layout.keys.length === 0) return { startIndex: 0, endIndex: 0 }

  const viewportBottomPx = clamp(distanceFromBottomPx, 0, layout.totalHeightPx)
  const viewportTopPx = clamp(
    viewportBottomPx + Math.max(0, viewportHeightPx),
    0,
    layout.totalHeightPx
  )
  const firstVisibleIndex = firstDescendingValueBelow(layout.bottomOffsetsPx, viewportTopPx)
  const topDistancesPx = layout.bottomOffsetsPx.map(
    (bottomOffsetPx, index) => bottomOffsetPx + (layout.heightsPx[index] ?? 0)
  )
  const firstIndexBelowViewport = firstDescendingValueAtMost(topDistancesPx, viewportBottomPx)
  const endVisibleIndex = Math.max(firstVisibleIndex + 1, firstIndexBelowViewport)

  return {
    startIndex: Math.max(0, firstVisibleIndex - overscanCount),
    endIndex: Math.min(layout.keys.length, endVisibleIndex + overscanCount),
  }
}

export function getAnchoredDistanceFromBottom({
  anchorKey,
  currentDistanceFromBottomPx,
  nextLayout,
  previousLayout,
}: {
  anchorKey: string
  currentDistanceFromBottomPx: number
  nextLayout: MessageVirtualLayout
  previousLayout: MessageVirtualLayout
}): number | null {
  const previousIndex = previousLayout.indexByKey.get(anchorKey)
  const nextIndex = nextLayout.indexByKey.get(anchorKey)
  if (previousIndex === undefined || nextIndex === undefined) return null

  const previousAnchorTopDistancePx =
    (previousLayout.bottomOffsetsPx[previousIndex] ?? 0) +
    (previousLayout.heightsPx[previousIndex] ?? 0)
  const nextAnchorTopDistancePx =
    (nextLayout.bottomOffsetsPx[nextIndex] ?? 0) + (nextLayout.heightsPx[nextIndex] ?? 0)

  return Math.max(
    0,
    currentDistanceFromBottomPx + nextAnchorTopDistancePx - previousAnchorTopDistancePx
  )
}

export function findMeasuredViewportAnchor({
  distanceFromBottomPx,
  layout,
  measuredHeightsByKey,
  viewportHeightPx,
}: {
  distanceFromBottomPx: number
  layout: MessageVirtualLayout
  measuredHeightsByKey: Readonly<Record<string, number>>
  viewportHeightPx: number
}): string | null {
  const range = getMessageVirtualRange({
    distanceFromBottomPx,
    layout,
    overscanCount: 0,
    viewportHeightPx,
  })
  for (let index = range.startIndex; index < range.endIndex; index += 1) {
    const key = layout.keys[index]
    if (key !== undefined && measuredHeightsByKey[key] !== undefined) return key
  }
  return null
}

function firstDescendingValueBelow(values: number[], threshold: number): number {
  let start = 0
  let end = values.length
  while (start < end) {
    const middle = Math.floor((start + end) / 2)
    if ((values[middle] ?? 0) < threshold) {
      end = middle
    } else {
      start = middle + 1
    }
  }
  return Math.min(start, Math.max(0, values.length - 1))
}

function firstDescendingValueAtMost(values: number[], threshold: number): number {
  let start = 0
  let end = values.length
  while (start < end) {
    const middle = Math.floor((start + end) / 2)
    if ((values[middle] ?? 0) <= threshold) {
      end = middle
    } else {
      start = middle + 1
    }
  }
  return start
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}
