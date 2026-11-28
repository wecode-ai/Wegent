import { useEffect, useSyncExternalStore } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { FrameHealthSampler } from './frameHealth'
import { foregroundTransition } from './foregroundLifecycle'
import { mobileTelemetry } from './mobileTelemetry'

const HEARTBEAT_INTERVAL_MS = 30_000

export function useMobileTelemetryState() {
  const snapshot = useSyncExternalStore(mobileTelemetry.subscribe, mobileTelemetry.getSnapshot)
  useEffect(() => {
    void mobileTelemetry.load()
  }, [])
  return snapshot
}

export function useMobileTelemetryRuntime() {
  const snapshot = useMobileTelemetryState()

  useEffect(() => {
    if (!snapshot.ready) return
    if (snapshot.enabled) {
      void mobileTelemetry.start().catch(() => undefined)
    } else if (snapshot.active) {
      void mobileTelemetry.stop().catch(() => undefined)
    }
  }, [snapshot.active, snapshot.enabled, snapshot.ready])

  useEffect(() => {
    if (!snapshot.active) return
    let appState = AppState.currentState
    let foregroundOpen = appState !== 'background'
    let request = 0
    const sampler = new FrameHealthSampler()
    const frame = (timestamp: number) => {
      request = 0
      const report = sampler.record(timestamp)
      if (report) mobileTelemetry.recordFrameHealth(report)
      if (appState === 'active') request = requestAnimationFrame(frame)
    }
    const schedule = () => {
      if (request === 0 && appState === 'active') request = requestAnimationFrame(frame)
    }
    const flushFrameHealth = () => {
      const report = sampler.flush(performance.now())
      if (report) mobileTelemetry.recordFrameHealth(report)
    }
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      appState = next
      if (next !== 'active' && request !== 0) {
        cancelAnimationFrame(request)
        request = 0
      }
      const transition = foregroundTransition(foregroundOpen, next)
      foregroundOpen = transition.foregroundOpen
      if (transition.action === 'end') {
        flushFrameHealth()
        mobileTelemetry.endForeground()
        mobileTelemetry.flush()
        return
      }
      if (transition.action === 'begin') mobileTelemetry.beginForeground()
      if (next === 'active') {
        sampler.reset()
        schedule()
      }
    })
    const heartbeat = setInterval(() => mobileTelemetry.heartbeat(), HEARTBEAT_INTERVAL_MS)
    schedule()
    return () => {
      if (request !== 0) cancelAnimationFrame(request)
      clearInterval(heartbeat)
      subscription.remove()
    }
  }, [snapshot.active])

  return snapshot
}
