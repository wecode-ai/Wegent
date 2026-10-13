import { cpus, freemem, loadavg, type CpuInfo } from 'node:os'

const boundaries = new Set([
  'electron-main-module:completed',
  'electron-ready:completed',
  'runtime-configure:completed',
  'primary-renderer-load:started',
  'primary-renderer-load:completed',
  'renderer-startup-ready:completed',
])

interface SystemResources {
  cpuTimes: CpuInfo['times'][]
  freeMemoryBytes: number
  loadAverage1m?: number
}

function readSystemResources(): SystemResources {
  return {
    cpuTimes: cpus().map(cpu => cpu.times),
    freeMemoryBytes: freemem(),
    // Node reports zero rather than an actual load average on Windows.
    loadAverage1m: process.platform === 'win32' ? undefined : loadavg()[0],
  }
}

export function startupSystemResources(
  step: string,
  status: string,
  enabled: boolean,
  read: () => SystemResources = readSystemResources
): Record<string, number | boolean> {
  if (!enabled || !boundaries.has(`${step}:${status}`)) return {}
  try {
    const sample = read()
    const values = sample.cpuTimes.flatMap(times => [
      times.user,
      times.nice,
      times.sys,
      times.idle,
      times.irq,
    ])
    const total = values.reduce((sum, value) => sum + value, 0)
    const idle = sample.cpuTimes.reduce((sum, times) => sum + times.idle, 0)
    if (
      !sample.cpuTimes.length ||
      ![...values, total, idle, sample.freeMemoryBytes].every(
        value => Number.isSafeInteger(value) && value >= 0
      )
    ) {
      return { systemResourcesAvailable: false }
    }
    return {
      systemResourcesAvailable: true,
      systemCpuCount: sample.cpuTimes.length,
      systemCpuTotalMs: total,
      systemCpuIdleMs: idle,
      systemFreeMemoryBytes: sample.freeMemoryBytes,
      ...(typeof sample.loadAverage1m === 'number' &&
      Number.isFinite(sample.loadAverage1m) &&
      sample.loadAverage1m >= 0
        ? { systemLoadAverage1m: sample.loadAverage1m }
        : {}),
    }
  } catch {
    return { systemResourcesAvailable: false }
  }
}
