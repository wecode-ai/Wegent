import { describe, expect, it } from 'vitest'
import type { ProcessKind, ProcessOwnerRef, ProcessRecord } from '@wegent/process-explorer'
import { groupProcesses } from './groupProcesses'

function record(
  pid: number,
  kind: ProcessKind,
  owner: ProcessOwnerRef,
  overrides: Partial<ProcessRecord> = {}
): ProcessRecord {
  return {
    id: `${pid}:1`,
    pid,
    parentPid: null,
    kind,
    source: 'electron',
    owner,
    name: `process-${pid}`,
    detail: null,
    cpuPercent: 1,
    memoryBytes: 1024,
    idleWakeupsPerSecond: null,
    startedAt: 1,
    ...overrides,
  }
}

const application: ProcessOwnerRef = {
  id: 'application',
  label: 'Application',
  key: 'application',
}
const windows: ProcessOwnerRef = { id: 'windows', label: 'Windows', key: 'windows' }
const helpers: ProcessOwnerRef = { id: 'helpers', label: 'Chromium helpers', key: 'helpers' }
const executor: ProcessOwnerRef = { id: 'executor', label: 'Executor', key: 'executor' }
const core: ProcessOwnerRef = { id: 'core-runtime', label: 'Core runtime', key: 'core-runtime' }

describe('process owner grouping', () => {
  it('groups by the owner supplied by the host', () => {
    const groups = groupProcesses([
      record(100, 'application', application),
      record(200, 'window', windows),
      record(300, 'gpu', helpers),
      record(400, 'utility', helpers),
    ])
    expect(groups.map(group => group.owner.id)).toEqual(['application', 'windows', 'helpers'])
    expect(groups.find(group => group.owner.id === 'helpers')?.processes).toHaveLength(2)
  })

  it('keeps host owners separate even when their names look similar', () => {
    const groups = groupProcesses([
      record(500, 'host-service', executor),
      record(600, 'host-service', core),
      record(501, 'host-child', executor),
    ])
    expect(groups.map(group => group.owner.id)).toEqual(['core-runtime', 'executor'])
    expect(groups.find(group => group.owner.id === 'executor')?.processes).toHaveLength(2)
  })

  it('orders workbench runtimes between the executor and plugin development', () => {
    const groups = groupProcesses([
      record(100, 'application', application),
      record(500, 'host-service', executor),
      record(700, 'host-service', {
        id: 'workbench:task-1',
        label: 'Workbench: task-1',
      }),
      record(800, 'host-service', {
        id: 'plugin-development',
        label: 'Plugin development',
        key: 'plugin-development',
      }),
      record(300, 'gpu', helpers),
    ])
    expect(groups.map(group => group.owner.id)).toEqual([
      'application',
      'executor',
      'workbench:task-1',
      'plugin-development',
      'helpers',
    ])
  })

  it('computes group totals', () => {
    const groups = groupProcesses([
      record(300, 'gpu', helpers, { cpuPercent: 2.5, memoryBytes: 100 }),
      record(301, 'utility', helpers, { cpuPercent: 1.5, memoryBytes: 200 }),
    ])
    expect(groups[0]).toMatchObject({ cpuPercent: 4, memoryBytes: 300 })
  })
})
