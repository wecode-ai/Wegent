import type { ProcessRecord } from '@wegent/process-explorer'
import { describe, expect, it } from 'vitest'
import { buildProcessTree, flattenProcessTree, type ProcessRow } from './processTree'

function row(pid: number, overrides: Partial<ProcessRecord> = {}): ProcessRow {
  return {
    id: `${pid}:1`,
    pid,
    parentPid: null,
    kind: 'system',
    source: 'system',
    owner: { id: 'other', label: 'Other processes' },
    name: `process-${pid}`,
    detail: null,
    cpuPercent: 0,
    memoryBytes: 0,
    idleWakeupsPerSecond: null,
    startedAt: 1000,
    ...overrides,
  }
}

function exited(pid: number, overrides: Partial<ProcessRecord> = {}): ProcessRow {
  return { ...row(pid, overrides), exitedAt: 5000 }
}

describe('process tree ordering', () => {
  it('orders siblings by memory and sinks exited processes below running ones', () => {
    const tree = buildProcessTree([
      row(1, { memoryBytes: 10 }),
      row(2, { parentPid: 1, memoryBytes: 10 }),
      row(3, { parentPid: 1, memoryBytes: 30 }),
      row(4, { parentPid: 1, memoryBytes: 20 }),
      exited(5, { parentPid: 1, memoryBytes: 90 }),
      row(10, { memoryBytes: 50 }),
    ])
    expect(flattenProcessTree(tree).map(node => [node.record.pid, node.depth])).toEqual([
      [10, 0],
      [1, 0],
      [3, 1],
      [4, 1],
      [2, 1],
      [5, 1],
    ])
  })
})
