import { describe, expect, it } from 'vitest'
import type { ProcessKind, ProcessRecord } from '@wegent/process-explorer'
import { buildProcessTree, filterProcessTree, flattenProcessTree } from './processTree'

function record(
  pid: number,
  parentPid: number | null,
  kind: ProcessKind,
  name: string,
  overrides: Partial<ProcessRecord> = {}
): ProcessRecord {
  return {
    id: `${pid}:1`,
    pid,
    parentPid,
    kind,
    source: kind === 'host-service' ? 'host' : 'electron',
    owner: { id: 'other', label: 'Other processes', key: 'other' },
    name,
    detail: null,
    cpuPercent: 1,
    memoryBytes: 1024,
    idleWakeupsPerSecond: null,
    startedAt: 1,
    ...overrides,
  }
}

describe('process tree', () => {
  it('nests executor children by parent pid', () => {
    const tree = buildProcessTree([
      record(500, 100, 'host-service', 'Executor'),
      record(501, 500, 'host-child', 'codex'),
      record(502, 501, 'system', 'bash'),
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0].record.pid).toBe(500)
    expect(tree[0].children[0].record.pid).toBe(501)
    expect(tree[0].children[0].children[0].record.pid).toBe(502)
  })

  it('treats records whose parent is outside the group as roots', () => {
    const tree = buildProcessTree([record(501, 999, 'host-child', 'codex')])
    expect(tree.map(node => node.record.pid)).toEqual([501])
  })

  it('breaks cycles without dropping processes', () => {
    const tree = buildProcessTree([record(1, 2, 'system', 'one'), record(2, 1, 'system', 'two')])
    expect(
      flattenProcessTree(tree)
        .map(node => node.record.pid)
        .sort()
    ).toEqual([1, 2])
  })

  it('keeps matching rows and their ancestors when filtering', () => {
    const tree = buildProcessTree([
      record(500, 100, 'host-service', 'Executor'),
      record(501, 500, 'host-child', 'codex'),
      record(502, 501, 'system', 'bash'),
    ])
    const filtered = filterProcessTree(tree, record => record.name === 'bash')
    expect(flattenProcessTree(filtered).map(node => node.record.pid)).toEqual([500, 501, 502])
  })

  it('sorts siblings by memory and reports render depth', () => {
    const tree = buildProcessTree([
      record(500, 100, 'host-service', 'Executor'),
      record(501, 500, 'host-child', 'small', { memoryBytes: 10 }),
      record(502, 500, 'host-child', 'large', { memoryBytes: 20 }),
    ])
    expect(tree[0].children.map(node => node.record.pid)).toEqual([502, 501])
    expect(flattenProcessTree(tree).map(node => node.depth)).toEqual([0, 1, 1])
  })
})
