import { describe, expect, test, vi } from 'vitest'

import {
  STARTUP_PROGRESS_STAGES,
  StartupProgressReporter,
  startupProgressTotalWeight,
  type StartupProgressUpdate,
} from './startup-progress.js'

describe('startup progress', () => {
  test('uses one bounded progress budget across every startup stage', () => {
    expect(STARTUP_PROGRESS_STAGES.length).toBeGreaterThan(1)
    expect(startupProgressTotalWeight()).toBe(100)
    expect(new Set(STARTUP_PROGRESS_STAGES.map(stage => stage.id)).size).toBe(
      STARTUP_PROGRESS_STAGES.length
    )
    for (const stage of STARTUP_PROGRESS_STAGES) {
      expect(stage.label.en).not.toBe('')
      expect(stage.label.zh).not.toBe('')
      expect(stage.detail.en).not.toBe('')
      expect(stage.detail.zh).not.toBe('')
      expect(stage.expectedMs).toBeGreaterThan(0)
      expect(stage.timeoutMs).toBeGreaterThanOrEqual(30_000)
    }
    expect(STARTUP_PROGRESS_STAGES.map(stage => stage.detail.zh).join('\n')).toContain(
      '正在扫描本地组件文件'
    )
    expect(STARTUP_PROGRESS_STAGES.map(stage => stage.detail.zh).join('\n')).toContain(
      '正在扫描并迁移工作区数据'
    )
  })

  test('publishes each real stage once with accumulated progress', () => {
    const updates: StartupProgressUpdate[] = []
    let now = 1_000
    const reporter = new StartupProgressReporter(
      update => updates.push(update),
      () => now++
    )

    reporter.report('launch')
    reporter.report('launch')
    reporter.report('components')
    reporter.report('shell')

    expect(updates.map(update => update.stage.id)).toEqual(['launch', 'components'])
    expect(updates[0]).toMatchObject({
      index: 0,
      total: STARTUP_PROGRESS_STAGES.length,
      completedWeight: 0,
      startedAt: 1_000,
    })
    expect(updates[1]).toMatchObject({
      index: 2,
      total: STARTUP_PROGRESS_STAGES.length,
      completedWeight: 10,
      startedAt: 1_001,
    })
  })

  test('rejects stage ids that are not part of the startup sequence', () => {
    const reporter = new StartupProgressReporter(vi.fn())

    expect(() => reporter.report('unknown-stage')).toThrow('Unknown startup progress stage')
  })

  test('throttles file activity while preserving the active stage', () => {
    const updates: StartupProgressUpdate[] = []
    let now = 1_000
    const reporter = new StartupProgressReporter(
      update => updates.push(update),
      () => now
    )

    reporter.reportActivity('scan', 'before-stage')
    reporter.report('components')
    now = 1_050
    reporter.reportActivity('scan', 'plugins/one.js')
    now = 1_100
    reporter.reportActivity('scan', 'plugins/two.js')
    now = 1_150
    reporter.reportActivity('scan', 'plugins/three.js')
    reporter.reportActivity('scan', '   ')

    expect(updates.map(update => update.activity?.path)).toEqual([
      undefined,
      'plugins/one.js',
      'plugins/three.js',
    ])
    expect(updates[2]).toMatchObject({
      index: 2,
      completedWeight: 10,
      startedAt: 1_000,
      activity: { kind: 'scan', path: 'plugins/three.js' },
    })
  })
})
