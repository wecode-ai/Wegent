import type { ProcessMetric, WebContents } from 'electron'
import { rendererStartupCpuDetails } from './startup-step.js'

type CpuMetric = Pick<ProcessMetric, 'pid' | 'type' | 'cpu'>

export function startupProcessCpuDetails(
  enabled: boolean,
  contents: Pick<WebContents, 'isDestroyed' | 'getOSProcessId'> | null,
  getMetrics: () => CpuMetric[]
): Record<string, unknown> {
  let snapshot: CpuMetric[] | undefined
  const renderer = rendererStartupCpuDetails(enabled, contents, () => {
    snapshot = getMetrics()
    return snapshot
  })
  if (!snapshot) return renderer
  try {
    return { ...renderer, ...summarizeProcessCpu(snapshot) }
  } catch {
    return { ...renderer, electronCpuAvailable: false }
  }
}

function summarizeProcessCpu(metrics: CpuMetric[]): Record<string, unknown> {
  const samples: { pid: number; kind: string; cpuMs: number }[] = []
  const seen = new Set<number>()
  let totalCpuMs = 0
  for (const metric of metrics) {
    const seconds = metric.cpu.cumulativeCPUUsage
    if (typeof seconds !== 'number') return { electronCpuAvailable: false }
    const cpuMs = Math.round(seconds * 1000)
    if (
      !Number.isSafeInteger(metric.pid) ||
      metric.pid <= 0 ||
      seen.has(metric.pid) ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      !Number.isSafeInteger(cpuMs) ||
      !Number.isSafeInteger(totalCpuMs + cpuMs)
    ) {
      return { electronCpuAvailable: false }
    }
    seen.add(metric.pid)
    totalCpuMs += cpuMs
    const kind =
      metric.type === 'Browser'
        ? 'browser'
        : metric.type === 'Tab'
          ? 'renderer'
          : metric.type === 'GPU'
            ? 'gpu'
            : metric.type === 'Utility'
              ? 'utility'
              : 'other'
    samples.push({ pid: metric.pid, kind, cpuMs })
  }
  if (samples.length === 0) return { electronCpuAvailable: false }
  samples.sort((left, right) => left.pid - right.pid)
  return {
    electronCpuAvailable: true,
    electronCpuTotalMs: totalCpuMs,
    electronCpuProcessCount: samples.length,
    electronCpuSamples: samples,
  }
}
