import { cpus } from 'node:os'

export interface CpuTimeSample {
  idle: number
  total: number
}

export function cpuTimeSample(): CpuTimeSample {
  return cpus().reduce<CpuTimeSample>(
    (sample, cpu) => ({
      idle: sample.idle + cpu.times.idle,
      total:
        sample.total +
        cpu.times.user +
        cpu.times.nice +
        cpu.times.sys +
        cpu.times.idle +
        cpu.times.irq,
    }),
    { idle: 0, total: 0 }
  )
}

export function cpuLoadRatioBetween(before: CpuTimeSample, after: CpuTimeSample): number {
  const totalDelta = after.total - before.total
  if (totalDelta <= 0) return 0
  const idleDelta = Math.max(0, after.idle - before.idle)
  return Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
}
