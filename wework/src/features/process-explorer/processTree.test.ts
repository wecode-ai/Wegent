import type { ProcessRecord } from '@wegent/process-explorer'
import { describe, expect, it } from 'vitest'
import {
  buildProcessTree,
  compareProcessRows,
  flattenProcessTree,
  type ProcessRow,
  type ProcessSort,
} from './processTree'

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
  it('sorts siblings under each parent and sinks exited processes', () => {
    const sort: ProcessSort = { column: 'name', direction: 'asc' }
    const tree = buildProcessTree(
      [
        row(1, { name: 'zsh' }),
        row(2, { parentPid: 1, name: 'bash' }),
        row(3, { parentPid: 1, name: 'awk' }),
        row(10, { name: 'yarn' }),
        exited(5, { parentPid: 1 }),
      ],
      sort
    )
    expect(flattenProcessTree(tree).map(node => [node.record.pid, node.depth])).toEqual([
      [10, 0],
      [1, 0],
      [3, 1],
      [2, 1],
      [5, 1],
    ])
  })

  it('sorts by the requested column and direction with unknown values last', () => {
    const byName: ProcessSort = { column: 'name', direction: 'desc' }
    expect(compareProcessRows(row(1, { name: 'b' }), row(2, { name: 'a' }), byName)).toBeLessThan(0)
    const byUptime: ProcessSort = { column: 'uptime', direction: 'asc' }
    const older = row(1, { startedAt: 100 })
    const newer = row(2, { startedAt: 1000 })
    expect(compareProcessRows(older, newer, byUptime)).toBeGreaterThan(0)
    expect(compareProcessRows(older, newer, { column: 'uptime', direction: 'desc' })).toBeLessThan(
      0
    )

    const byCpu: ProcessSort = { column: 'cpu', direction: 'desc' }
    const unknown = row(1, { cpuPercent: null })
    const measured = row(2, { cpuPercent: 0.5 })
    expect(compareProcessRows(unknown, measured, byCpu)).toBeGreaterThan(0)
    expect(
      compareProcessRows(unknown, measured, { column: 'cpu', direction: 'asc' })
    ).toBeGreaterThan(0)
  })
})
