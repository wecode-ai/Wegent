import type { ExitedProcessRecord, ProcessRecord } from '@wegent/process-explorer'

export type ProcessRow = ProcessRecord | ExitedProcessRecord

export type SortColumn = 'name' | 'pid' | 'cpu' | 'memory' | 'uptime'

export interface ProcessSort {
  column: SortColumn
  direction: 'asc' | 'desc'
}

export const DEFAULT_PROCESS_SORT: ProcessSort = { column: 'memory', direction: 'desc' }

export function isExited(record: ProcessRow): record is ExitedProcessRecord {
  return 'exitedAt' in record
}

export interface ProcessTreeNode {
  record: ProcessRow
  children: ProcessTreeNode[]
}

export interface FlatProcessNode {
  record: ProcessRow
  depth: number
}

/**
 * Orders siblings of one parent. Exited processes sink below running ones so
 * a process keeps its neighbours' order while it fades out, and unknown values
 * sort last regardless of direction.
 */
export function compareProcessRows(left: ProcessRow, right: ProcessRow, sort: ProcessSort): number {
  const exited = Number(isExited(left)) - Number(isExited(right))
  if (exited !== 0) return exited

  const leftValue = sortValue(left, sort.column)
  const rightValue = sortValue(right, sort.column)
  if (leftValue === null || rightValue === null) {
    if (leftValue !== rightValue) return leftValue === null ? 1 : -1
  } else {
    const delta =
      typeof leftValue === 'string'
        ? leftValue.localeCompare(rightValue as string)
        : leftValue - (rightValue as number)
    if (delta !== 0) return sort.direction === 'asc' ? delta : -delta
  }
  return left.pid - right.pid
}

/** Ascending value of one column, or null when the platform did not report it. */
function sortValue(record: ProcessRow, column: SortColumn): string | number | null {
  switch (column) {
    case 'name':
      return record.name
    case 'pid':
      return record.pid
    case 'cpu':
      return record.cpuPercent
    case 'memory':
      return record.memoryBytes
    case 'uptime':
      // Older start times mean longer uptime, so negate to sort uptime ascending.
      return record.startedAt === null ? null : -record.startedAt
  }
}

/**
 * Builds a parent/child tree inside one owner group. Records whose parent is
 * outside the group become roots. A cycle is broken after the first visit so a
 * corrupt process table cannot drop the whole group.
 */
export function buildProcessTree(
  processes: readonly ProcessRow[],
  sort: ProcessSort = DEFAULT_PROCESS_SORT
): ProcessTreeNode[] {
  const byPid = new Map(processes.map(record => [record.pid, record]))
  const childrenByParent = new Map<number, ProcessRow[]>()
  for (const record of processes) {
    if (
      record.parentPid === null ||
      record.parentPid === record.pid ||
      !byPid.has(record.parentPid)
    ) {
      continue
    }
    const children = childrenByParent.get(record.parentPid) ?? []
    children.push(record)
    childrenByParent.set(record.parentPid, children)
  }

  const visited = new Set<number>()
  const build = (record: ProcessRow): ProcessTreeNode => {
    visited.add(record.pid)
    const children = (childrenByParent.get(record.pid) ?? [])
      .filter(child => !visited.has(child.pid))
      .sort((left, right) => compareProcessRows(left, right, sort))
      .map(build)
    return { record, children }
  }

  const isRoot = (record: ProcessRow) =>
    record.parentPid === null || record.parentPid === record.pid || !byPid.has(record.parentPid)

  const roots = processes
    .filter(isRoot)
    .sort((left, right) => compareProcessRows(left, right, sort))
    .map(build)
  for (const record of processes) {
    if (!visited.has(record.pid)) roots.push(build(record))
  }
  return roots
}

/** Keeps matching rows and their ancestors, removing empty branches. */
export function filterProcessTree(
  nodes: readonly ProcessTreeNode[],
  matches: (record: ProcessRow) => boolean
): ProcessTreeNode[] {
  return nodes.flatMap(node => {
    const children = filterProcessTree(node.children, matches)
    if (!matches(node.record) && children.length === 0) return []
    return [{ record: node.record, children }]
  })
}

/** Flattens a tree into render order with an explicit indentation depth. */
export function flattenProcessTree(
  nodes: readonly ProcessTreeNode[],
  depth = 0
): FlatProcessNode[] {
  return nodes.flatMap(node => [
    { record: node.record, depth },
    ...flattenProcessTree(node.children, depth + 1),
  ])
}
