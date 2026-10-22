import { describe, expect, it } from 'vitest'
import {
  buildProcessSnapshot,
  collectDescendantPids,
  kindFromElectronType,
  type ElectronProcessMetric,
  type SystemProcessInfo,
} from './build-snapshot.js'

function metric(
  pid: number,
  type: string,
  overrides: Partial<ElectronProcessMetric> = {}
): ElectronProcessMetric {
  return {
    pid,
    type,
    creationTime: 1000 + pid,
    cpu: { percentCPUUsage: 1, idleWakeupsPerSecond: 0 },
    memory: { workingSetSize: 1024 },
    ...overrides,
  }
}

function systemRow(
  pid: number,
  parentPid: number,
  overrides: Partial<SystemProcessInfo> = {}
): SystemProcessInfo {
  return {
    pid,
    parentPid,
    name: `process-${pid}`,
    command: `/bin/process-${pid} --flag`,
    cpuPercent: 2,
    memoryBytes: 4096,
    startedAt: null,
    identity: '',
    ...overrides,
  }
}

describe('process snapshot assembly', () => {
  it('maps Electron process types to semantic kinds', () => {
    expect(kindFromElectronType('Browser')).toBe('application')
    expect(kindFromElectronType('Tab')).toBe('window')
    expect(kindFromElectronType('GPU')).toBe('gpu')
    expect(kindFromElectronType('Utility')).toBe('utility')
    expect(kindFromElectronType('Zygote')).toBe('zygote')
    expect(kindFromElectronType('Sandbox helper')).toBe('sandbox-helper')
    expect(kindFromElectronType('Pepper Plugin')).toBe('pepper')
    expect(kindFromElectronType('Unknown')).toBe('system')
  })

  it('uses the host application name for the browser process', () => {
    const snapshot = buildProcessSnapshot({
      capturedAt: 1,
      platform: 'darwin',
      applicationPid: 10,
      applicationName: 'WeWork',
      metrics: [metric(10, 'Browser')],
    })
    expect(snapshot.processes[0].name).toBe('WeWork')
  })

  it('uses pid and creation time as a stable identity', () => {
    const snapshot = buildProcessSnapshot({
      capturedAt: 1,
      platform: 'darwin',
      applicationPid: 10,
      metrics: [metric(10, 'Browser', { creationTime: 777 })],
    })
    expect(snapshot.processes[0].id).toBe('10:777')
    expect(snapshot.processes[0].startedAt).toBe(777)
    expect(snapshot.platform).toBe('darwin')
  })

  it('converts Electron kilobytes to bytes and assigns owners', () => {
    const snapshot = buildProcessSnapshot({
      capturedAt: 1,
      platform: 'darwin',
      applicationPid: 10,
      metrics: [
        metric(10, 'Browser'),
        metric(11, 'GPU', { memory: { workingSetSize: 2048 } }),
        metric(12, 'Tab'),
      ],
    })
    const byPid = new Map(snapshot.processes.map(record => [record.pid, record]))
    expect(byPid.get(11)?.memoryBytes).toBe(2048 * 1024)
    expect(snapshot.processes[0].kind).toBe('application')
    expect(byPid.get(10)?.owner.id).toBe('application')
    expect(byPid.get(11)?.owner.id).toBe('helpers')
    expect(byPid.get(12)?.owner.id).toBe('windows')
  })

  it('labels a renderer from its window instead of its launch detail', () => {
    const snapshot = buildProcessSnapshot({
      capturedAt: 1,
      platform: 'darwin',
      applicationPid: 10,
      metrics: [metric(10, 'Browser'), metric(12, 'Tab')],
      windows: [{ pid: 12, label: 'Task — Refactor' }],
      system: [systemRow(12, 10, { command: 'Electron Helper --type=renderer' })],
    })
    const windowProcess = snapshot.processes.find(record => record.pid === 12)
    expect(windowProcess?.kind).toBe('window')
    expect(windowProcess?.name).toBe('Task — Refactor')
    expect(windowProcess?.detail).toBe('Electron Helper --type=renderer')
    expect(windowProcess?.owner.id).toBe('windows')
  })

  it('overrides an injected process label', () => {
    const snapshot = buildProcessSnapshot({
      capturedAt: 1,
      platform: 'darwin',
      applicationPid: 10,
      metrics: [metric(10, 'Browser')],
      system: [systemRow(42, 10, { command: '/opt/wegent/executor serve' })],
      hostProcesses: [
        {
          pid: 42,
          name: 'Executor',
          kind: 'host-service',
          identity: 'executor',
          owner: { id: 'executor', label: 'Executor', key: 'executor' },
        },
      ],
    })
    const executor = snapshot.processes.find(record => record.pid === 42)
    expect(executor).toMatchObject({
      id: '42:executor',
      kind: 'host-service',
      source: 'host',
      owner: { id: 'executor', label: 'Executor', key: 'executor' },
      name: 'Executor',
      detail: '/opt/wegent/executor serve',
    })
  })

  it('includes injected processes that the system table does not report', () => {
    const snapshot = buildProcessSnapshot({
      capturedAt: 1,
      platform: 'darwin',
      applicationPid: 10,
      metrics: [metric(10, 'Browser')],
      hostProcesses: [
        {
          pid: 99,
          name: 'Agent runtime',
          kind: 'host-service',
          owner: { id: 'agent-runtime', label: 'Agent runtime' },
        },
      ],
    })
    expect(snapshot.processes.find(record => record.pid === 99)).toMatchObject({
      name: 'Agent runtime',
      cpuPercent: null,
      memoryBytes: null,
    })
  })

  it('adds descendants of the application and injected roots', () => {
    const snapshot = buildProcessSnapshot({
      capturedAt: 1,
      platform: 'darwin',
      applicationPid: 10,
      metrics: [metric(10, 'Browser')],
      system: [
        systemRow(10, 1),
        systemRow(42, 10),
        systemRow(43, 42),
        systemRow(44, 10),
        systemRow(50, 1),
      ],
      hostProcesses: [
        {
          pid: 42,
          name: 'Executor',
          kind: 'host-service',
          owner: { id: 'executor', label: 'Executor', key: 'executor' },
          includeDescendants: true,
        },
      ],
    })
    const byPid = new Map(snapshot.processes.map(record => [record.pid, record]))
    expect(byPid.get(43)?.kind).toBe('host-child')
    expect(byPid.get(43)?.owner.id).toBe('executor')
    expect(byPid.get(44)?.kind).toBe('system')
    expect(byPid.get(44)?.owner.id).toBe('other')
    expect(byPid.has(50)).toBe(false)
  })

  it('collects descendants without looping on a parent cycle', () => {
    const rows = [systemRow(1, 2), systemRow(2, 1), systemRow(3, 2)]
    expect([...collectDescendantPids(rows, [1])].sort()).toEqual([2, 3])
  })

  it('passes structured degradations through unchanged', () => {
    const degraded = [{ code: 'system-process-table-failed' as const, detail: 'timeout' }]
    const snapshot = buildProcessSnapshot({
      capturedAt: 1,
      platform: 'darwin',
      applicationPid: 10,
      metrics: [metric(10, 'Browser')],
      degraded,
    })
    expect(snapshot.degraded).toEqual(degraded)
  })
})
