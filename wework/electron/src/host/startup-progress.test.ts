import { describe, expect, test, vi } from 'vitest'

import {
  STARTUP_PROGRESS_STAGES,
  StartupProgressReporter,
  desktopE2EStartupTiming,
  startupProgressTotalWeight,
  type StartupProgressUpdate,
} from './startup-progress.js'

describe('startup progress', () => {
  test('shortens only real timers in a controlled desktop E2E process', () => {
    const environment = {
      VITE_WEWORK_E2E: 'true',
      WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234',
      WEWORK_E2E_STARTUP_SLOW_AFTER_MS: '500',
      WEWORK_E2E_STARTUP_STAGE_TIMEOUT_MS: '1200',
    }
    const timing = desktopE2EStartupTiming(environment)
    expect(timing).toEqual({ slowAfterMs: 500, stageTimeoutMs: 1200 })
    expect(desktopE2EStartupTiming({ ...environment, VITE_WEWORK_E2E: 'false' })).toBeNull()
    expect(desktopE2EStartupTiming({ ...environment, WEWORK_E2E_CONTROL_URL: '' })).toBeNull()
    expect(
      desktopE2EStartupTiming({ ...environment, WEWORK_E2E_STARTUP_STAGE_TIMEOUT_MS: '100' })
    ).toBeNull()
    const reporter = new StartupProgressReporter(vi.fn(), () => 1234, timing)
    reporter.report('renderer')
    expect(reporter.currentUpdate()).toMatchObject({
      startedAt: 1234,
      stage: { id: 'renderer', timeoutMs: 1200 },
    })
    expect(STARTUP_PROGRESS_STAGES.at(-1)?.timeoutMs).toBe(60_000)
  })

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

  test('keeps a stage history and current activity for diagnostics', () => {
    let now = 1_000
    const reporter = new StartupProgressReporter(vi.fn(), () => now)

    reporter.report('launch')
    now = 1_200
    reporter.reportActivity('scan', 'plugins/first.js')
    now = 1_500
    reporter.report('components')
    now = 1_700
    reporter.reportActivity('scan', 'plugins/second.js')

    expect(reporter.history().map(update => update.stage.id)).toEqual(['launch', 'components'])
    expect(reporter.history()[0]?.activity).toBeUndefined()
    expect(reporter.currentUpdate()).toMatchObject({
      stage: { id: 'components' },
      activity: { kind: 'scan', path: 'plugins/second.js' },
    })
  })
})
