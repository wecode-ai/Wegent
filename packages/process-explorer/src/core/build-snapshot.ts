import type {
  HostProcessDescriptor,
  ProcessDegradation,
  ProcessKind,
  ProcessOwnerRef,
  ProcessRecord,
  ProcessSnapshot,
} from '../contract.js'

/** Electron `ProcessMetric` fields the explorer depends on. */
export interface ElectronProcessMetric {
  pid: number
  type: string
  name?: string
  serviceName?: string
  creationTime: number
  cpu: {
    percentCPUUsage: number
    idleWakeupsPerSecond: number
  }
  memory: {
    workingSetSize: number
  }
}

export interface WindowProcessInfo {
  pid: number
  label: string
}

/** One row from a platform process table. */
export interface SystemProcessInfo {
  pid: number
  parentPid: number
  name: string
  command: string | null
  cpuPercent: number | null
  memoryBytes: number | null
  /** Process start time in epoch milliseconds, or null when unavailable. */
  startedAt: number | null
  /** Creation time as an opaque identity string, or '' when unavailable. */
  identity: string
}

export interface BuildProcessSnapshotInput {
  capturedAt: number
  platform: string
  applicationPid: number
  applicationName?: string
  metrics: readonly ElectronProcessMetric[]
  windows?: readonly WindowProcessInfo[]
  system?: readonly SystemProcessInfo[]
  hostProcesses?: readonly HostProcessDescriptor[]
  degraded?: readonly ProcessDegradation[]
}

export function kindFromElectronType(type: string): ProcessKind {
  switch (type) {
    case 'Browser':
      return 'application'
    case 'Tab':
      return 'window'
    case 'GPU':
      return 'gpu'
    case 'Utility':
      return 'utility'
    case 'Zygote':
      return 'zygote'
    case 'Sandbox helper':
      return 'sandbox-helper'
    case 'Pepper Plugin':
    case 'Pepper Plugin Broker':
      return 'pepper'
    default:
      return 'system'
  }
}

export function defaultOwnerForKind(kind: ProcessKind): ProcessOwnerRef {
  switch (kind) {
    case 'application':
      return { id: 'application', label: 'Application', key: 'application' }
    case 'window':
      return { id: 'windows', label: 'Windows', key: 'windows' }
    case 'gpu':
    case 'utility':
    case 'zygote':
    case 'sandbox-helper':
    case 'pepper':
      return { id: 'helpers', label: 'Chromium helpers', key: 'helpers' }
    default:
      return { id: 'other', label: 'Other processes', key: 'other' }
  }
}

export function defaultKindName(kind: ProcessKind): string {
  switch (kind) {
    case 'application':
      return 'Application'
    case 'window':
      return 'Window'
    case 'gpu':
      return 'GPU Process'
    case 'utility':
      return 'Utility Process'
    case 'zygote':
      return 'Zygote'
    case 'sandbox-helper':
      return 'Sandbox Helper'
    case 'pepper':
      return 'Pepper Plugin'
    case 'host-service':
    case 'host-child':
      return 'Host Process'
    case 'system':
      return 'Process'
  }
}

/**
 * Returns every descendant of the roots, excluding the roots themselves.
 * Parent links that form a cycle are visited once, so a corrupt process table
 * cannot loop forever.
 */
export function collectDescendantPids(
  processes: readonly SystemProcessInfo[],
  roots: readonly number[]
): Set<number> {
  const childrenByParent = new Map<number, number[]>()
  for (const processInfo of processes) {
    const children = childrenByParent.get(processInfo.parentPid) ?? []
    children.push(processInfo.pid)
    childrenByParent.set(processInfo.parentPid, children)
  }

  const rootSet = new Set(roots)
  const descendants = new Set<number>()
  const pending = [...roots]
  while (pending.length > 0) {
    const pid = pending.pop()
    if (pid === undefined) continue
    for (const child of childrenByParent.get(pid) ?? []) {
      if (rootSet.has(child) || descendants.has(child)) continue
      descendants.add(child)
      pending.push(child)
    }
  }
  return descendants
}

export function buildProcessSnapshot(input: BuildProcessSnapshotInput): ProcessSnapshot {
  const systemByPid = new Map<number, SystemProcessInfo>()
  for (const processInfo of input.system ?? []) {
    systemByPid.set(processInfo.pid, processInfo)
  }

  const records = new Map<number, ProcessRecord>()
  for (const metric of input.metrics) {
    const systemRow = systemByPid.get(metric.pid)
    const kind =
      metric.pid === input.applicationPid ? 'application' : kindFromElectronType(metric.type)
    records.set(metric.pid, {
      id: `${metric.pid}:${metric.creationTime}`,
      pid: metric.pid,
      parentPid: systemRow?.parentPid ?? null,
      kind,
      source: 'electron',
      owner: defaultOwnerForKind(kind),
      name:
        metric.pid === input.applicationPid
          ? (input.applicationName ?? metric.name ?? defaultKindName(kind))
          : (metric.name ?? metric.serviceName ?? defaultKindName(kind)),
      // The system table supplies launch details Electron does not report.
      detail: systemRow?.command ?? metric.serviceName ?? null,
      cpuPercent: finiteOrNull(metric.cpu.percentCPUUsage),
      // Electron reports memory in kilobytes.
      memoryBytes: megabytesToBytes(metric.memory.workingSetSize),
      idleWakeupsPerSecond: finiteOrNull(metric.cpu.idleWakeupsPerSecond),
      startedAt: finiteOrNull(metric.creationTime),
    })
  }

  for (const windowProcess of input.windows ?? []) {
    const record = records.get(windowProcess.pid)
    if (!record) continue
    record.kind = 'window'
    record.owner = defaultOwnerForKind('window')
    record.name = windowProcess.label
  }

  const injectedRoots: number[] = []
  const injectedOwners = new Map<number, ProcessOwnerRef>()
  for (const descriptor of input.hostProcesses ?? []) {
    if (!Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0) continue
    if (descriptor.includeDescendants) injectedRoots.push(descriptor.pid)
    injectedOwners.set(descriptor.pid, descriptor.owner)
    const systemRow = systemByPid.get(descriptor.pid)
    const existing = records.get(descriptor.pid)
    if (existing) {
      existing.kind = descriptor.kind
      existing.source = 'host'
      existing.owner = descriptor.owner
      existing.name = descriptor.name
      continue
    }
    records.set(descriptor.pid, {
      id: `${descriptor.pid}:${descriptor.identity ?? systemRow?.identity ?? ''}`,
      pid: descriptor.pid,
      parentPid: systemRow?.parentPid ?? null,
      kind: descriptor.kind,
      source: 'host',
      owner: descriptor.owner,
      name: descriptor.name,
      detail: systemRow?.command ?? null,
      cpuPercent: systemRow?.cpuPercent ?? null,
      memoryBytes: systemRow?.memoryBytes ?? null,
      idleWakeupsPerSecond: null,
      startedAt: systemRow?.startedAt ?? null,
    })
  }

  const systemProcesses = input.system ?? []
  if (systemProcesses.length > 0) {
    const parentByPid = new Map(systemProcesses.map(row => [row.pid, row.parentPid]))
    const roots = [input.applicationPid, ...injectedRoots]
    for (const pid of collectDescendantPids(systemProcesses, roots)) {
      if (records.has(pid)) continue
      const systemRow = systemByPid.get(pid)
      if (!systemRow) continue
      const owner = findInjectedOwner(pid, injectedOwners, parentByPid)
      records.set(pid, {
        id: `${pid}:${systemRow.identity}`,
        pid,
        parentPid: systemRow.parentPid,
        kind: owner ? 'host-child' : 'system',
        source: 'system',
        owner: owner ?? defaultOwnerForKind('system'),
        name: systemRow.name || defaultKindName('system'),
        detail: systemRow.command,
        cpuPercent: systemRow.cpuPercent,
        memoryBytes: systemRow.memoryBytes,
        idleWakeupsPerSecond: null,
        startedAt: systemRow.startedAt,
      })
    }
  }

  const processes = [...records.values()].sort(compareRecords)

  return {
    capturedAt: input.capturedAt,
    platform: input.platform,
    applicationPid: input.applicationPid,
    processes,
    degraded: [...(input.degraded ?? [])],
  }
}

function findInjectedOwner(
  pid: number,
  ownersByPid: ReadonlyMap<number, ProcessOwnerRef>,
  parentByPid: ReadonlyMap<number, number>
): ProcessOwnerRef | null {
  const visited = new Set<number>()
  let current = parentByPid.get(pid)
  while (current !== undefined && !visited.has(current)) {
    const owner = ownersByPid.get(current)
    if (owner) return owner
    visited.add(current)
    current = parentByPid.get(current)
  }
  return null
}

function compareRecords(left: ProcessRecord, right: ProcessRecord): number {
  if (left.kind === 'application') return -1
  if (right.kind === 'application') return 1
  const leftMemory = left.memoryBytes ?? -1
  const rightMemory = right.memoryBytes ?? -1
  if (leftMemory !== rightMemory) return rightMemory - leftMemory
  return left.pid - right.pid
}

function megabytesToBytes(kilobytes: number): number | null {
  if (!Number.isFinite(kilobytes) || kilobytes < 0) return null
  return Math.round(kilobytes * 1024)
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null
}
