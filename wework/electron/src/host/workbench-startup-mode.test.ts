import { describe, expect, it, vi } from 'vitest'
import { workbenchStartupMode, startWorkbenchSession } from './workbench-startup-mode.js'
import { StartupTelemetryLifecycle, StartupTelemetrySuccessGate } from './startup-telemetry.js'

const trial = {
  hasApplicationRequest: true,
  hasWorkbenchRequest: false,
  activeReleaseId: 'target',
  activation: { to: 'target', token: 'activation-token' },
  healthyActivationToken: null,
}

describe('application startup mode', () => {
  it('runs the real workbench invisibly for an unconfirmed active release', () => {
    expect(workbenchStartupMode(trial)).toBe('background-workbench')
    expect(workbenchStartupMode({ ...trial, healthyActivationToken: 'older-token' })).toBe(
      'background-workbench'
    )
  })

  it('keeps ordinary healthy application launches independent of the workbench', () => {
    expect(workbenchStartupMode({ ...trial, activation: null })).toBe('application-only')
    expect(workbenchStartupMode({ ...trial, healthyActivationToken: trial.activation.token })).toBe(
      'application-only'
    )
    expect(workbenchStartupMode({ ...trial, activeReleaseId: 'source' })).toBe('application-only')
    expect(workbenchStartupMode({ ...trial, activeReleaseId: undefined })).toBe('application-only')
  })

  it('honors explicit workbench activation and mixed native requests', () => {
    expect(workbenchStartupMode({ ...trial, hasWorkbenchRequest: true })).toBe('workbench')
    expect(workbenchStartupMode({ ...trial, hasApplicationRequest: false })).toBe('workbench')
  })

  it.each(['workbench', 'background-workbench', 'application-only'] as const)(
    'starts host infrastructure before an unfinished app document in %s mode',
    async mode => {
      const events: string[] = []
      let finishOpen!: () => void
      let opened!: () => void
      const opening = new Promise<void>(resolve => {
        finishOpen = resolve
      })
      const openingStarted = new Promise<void>(resolve => {
        opened = resolve
      })
      const startWorkbench = vi.fn(async () => {
        events.push('workbench-health-started')
      })
      const startControlBridge = vi.fn(async () => {
        events.push('control-started')
      })
      const startup = startWorkbenchSession(mode, {
        startWorkbench,
        startControlBridge,
        openApplications: async () => {
          events.push('app-opening')
          opened()
          await opening
          events.push('app-opened')
        },
      })

      const hostEvent = mode === 'application-only' ? 'control-started' : 'workbench-health-started'
      await openingStarted
      try {
        expect(events).toEqual([hostEvent, 'app-opening'])
        expect(
          mode === 'application-only' ? startWorkbench : startControlBridge
        ).not.toHaveBeenCalled()
      } finally {
        finishOpen()
        await startup
      }
      expect(events).toEqual([hostEvent, 'app-opening', 'app-opened'])
    }
  )

  it.each(['runtime', 'renderer'] as const)(
    'requires both genuine readiness events when %s is ready first',
    first => {
      expect(workbenchStartupMode(trial)).toBe('background-workbench')
      const publish = vi.fn()
      const lifecycle = new StartupTelemetryLifecycle({ id: 'trial', now: () => 0, publish })
      const gate = new StartupTelemetrySuccessGate(lifecycle)
      lifecycle.start()

      const firstReady = first === 'runtime' ? 'markRuntimeReady' : 'markRendererReady'
      const secondReady = first === 'runtime' ? 'markRendererReady' : 'markRuntimeReady'
      expect(gate[firstReady]()).toBe(false)
      expect(publish.mock.calls.map(([type]) => type)).toEqual(['startup.attempted'])
      expect(gate[secondReady]()).toBe(true)
      expect(publish.mock.calls.map(([type]) => type)).toEqual([
        'startup.attempted',
        'startup.succeeded',
      ])
    }
  )

  it('keeps a failed background validation failed after later readiness events', () => {
    expect(workbenchStartupMode(trial)).toBe('background-workbench')
    const publish = vi.fn()
    const lifecycle = new StartupTelemetryLifecycle({ id: 'trial', now: () => 0, publish })
    const gate = new StartupTelemetrySuccessGate(lifecycle)
    lifecycle.start()
    lifecycle.fail('renderer_load')
    gate.markRuntimeReady()
    gate.markRendererReady()
    expect(publish.mock.calls.map(([type]) => type)).toEqual([
      'startup.attempted',
      'startup.failed',
    ])
  })
})
