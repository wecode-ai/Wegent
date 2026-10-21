import type { ProcessOwnerRef, ProcessRecord } from '@wegent/process-explorer'

export interface ProcessGroup {
  owner: ProcessOwnerRef
  processes: ProcessRecord[]
  cpuPercent: number
  memoryBytes: number
}

const OWNER_ORDER: Readonly<Record<string, number>> = {
  application: 0,
  windows: 10,
  'core-runtime': 20,
  executor: 30,
  'plugin-development': 50,
  helpers: 60,
  other: 100,
}

/**
 * Groups a snapshot by the owner supplied by the host. The renderer never
 * infers ownership from display names, so a new runtime only needs a host
 * descriptor.
 */
export function groupProcesses(processes: readonly ProcessRecord[]): ProcessGroup[] {
  const groups = new Map<string, { owner: ProcessOwnerRef; processes: ProcessRecord[] }>()
  for (const record of processes) {
    const existing = groups.get(record.owner.id)
    if (existing) existing.processes.push(record)
    else groups.set(record.owner.id, { owner: record.owner, processes: [record] })
  }

  return [...groups.values()]
    .sort((left, right) => {
      const rankDelta = ownerRank(left.owner) - ownerRank(right.owner)
      return rankDelta !== 0 ? rankDelta : left.owner.label.localeCompare(right.owner.label)
    })
    .map(group => ({
      owner: group.owner,
      processes: group.processes,
      cpuPercent: sum(group.processes.map(record => record.cpuPercent)),
      memoryBytes: sum(group.processes.map(record => record.memoryBytes)),
    }))
}

function ownerRank(owner: ProcessOwnerRef): number {
  if (owner.id.startsWith('workbench:')) return 40
  return OWNER_ORDER[owner.id] ?? 70
}

function sum(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0)
}
