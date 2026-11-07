import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, statfsSync } from 'node:fs'
import { availableParallelism, cpus, freemem, loadavg, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'
import { diskRootMetadata, openDeletedDiskFiles } from './runner-process-disk.mjs'

const [command, ...args] = process.argv.slice(2)
if (!command) throw new Error('A command is required')

const sampleIntervalMs = Number(process.env.RUNNER_RESOURCE_SAMPLE_INTERVAL_MS ?? 15_000)
if (!Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs < 100) {
  throw new Error('RUNNER_RESOURCE_SAMPLE_INTERVAL_MS must be an integer of at least 100')
}

const logPath = resolve(
  process.env.RUNNER_RESOURCE_LOG_PATH ?? 'wework/test-results/desktop-e2e/runner-resources.jsonl'
)
mkdirSync(dirname(logPath), { recursive: true })

function readMetric(path) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch (error) {
    return { unavailable: error.code }
  }
}

function cpuTimes() {
  return cpus().reduce(
    (sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
    }),
    { idle: 0, total: 0 }
  )
}

let previousCpu = cpuTimes()
let child
let smallestDiskPressureTier = Infinity
let initialDiskAvailableBytes
let sampledDiskGrowth = false
let initialSampleAt
let sampledScheduledProcesses = false
const processSampleAfterMs = Number(process.env.RUNNER_PROCESS_SAMPLE_AFTER_MS)

function diskUsage(depth) {
  const paths = [
    'wework/test-results/desktop-e2e',
    '/tmp',
    process.env.RUNNER_TEMP ?? '/__w/_temp',
    '.ci-artifacts',
    'backend/.venv',
    '/root/.cache',
    '/root/go',
  ].filter(existsSync)
  const filesystems = diskRootMetadata(['.', ...paths])
  let output
  let incomplete
  try {
    output = execFileSync('du', ['-k', '-x', '-d', String(depth), '--', ...paths], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (error) {
    output = String(error.stdout ?? '')
    incomplete = { reason: error.code ?? error.name, status: error.status, signal: error.signal }
  }
  return {
    filesystems,
    incomplete,
    directories: output
      .trim()
      .split('\n')
      .filter(line => /^\d+\t.+/.test(line))
      .map(line => {
        const separator = line.indexOf('\t')
        return {
          allocatedBytes: Number(line.slice(0, separator)) * 1024,
          path: line.slice(separator + 1),
        }
      })
      .filter(entry => Number.isFinite(entry.allocatedBytes))
      .sort((left, right) => right.allocatedBytes - left.allocatedBytes)
      .slice(0, 40),
  }
}

function sample(phase, exitCode, schedulingDelayMs) {
  const sampledAt = Date.now()
  initialSampleAt ??= sampledAt
  const currentCpu = cpuTimes()
  const elapsed = currentCpu.total - previousCpu.total
  const disk = statfsSync('.')
  initialDiskAvailableBytes ??= disk.bavail * disk.bsize
  const record = {
    timestamp: new Date(sampledAt).toISOString(),
    elapsedMs: sampledAt - initialSampleAt,
    phase,
    sampleIntervalMs,
    schedulingDelayMs,
    exitCode,
    commandPid: child?.pid,
    parallelCheckpoints: process.env.WEWORK_E2E_PARALLEL_CHECKPOINTS,
    cpuCount: cpus().length,
    availableParallelism: availableParallelism(),
    cpuBusyPercent:
      phase !== 'start' && elapsed > 0
        ? Math.round(100 * (1 - (currentCpu.idle - previousCpu.idle) / elapsed))
        : null,
    loadAverage: loadavg(),
    memoryTotalBytes: totalmem(),
    memoryFreeBytes: freemem(),
    diskAvailableBytes: disk.bavail * disk.bsize,
    diskTotalBytes: disk.blocks * disk.bsize,
    diskInitialAvailableBytes: initialDiskAvailableBytes,
    diskAvailableDecreaseBytes: Math.max(0, initialDiskAvailableBytes - disk.bavail * disk.bsize),
    diskAvailableInodes: disk.ffree,
  }
  if (process.platform === 'linux') {
    const pressureTier = Math.floor(Math.log2(Math.max(record.diskAvailableBytes, 1)))
    const desktopRun = Boolean(process.env.WEWORK_E2E_PARALLEL_CHECKPOINTS)
    const lowFree =
      record.diskAvailableBytes < 4 * 1024 ** 3 && pressureTier < smallestDiskPressureTier
    const growth =
      desktopRun && !sampledDiskGrowth && record.diskAvailableDecreaseBytes >= 8 * 1024 ** 3
    const baseline = desktopRun && phase === 'start'
    const scheduled =
      desktopRun &&
      !sampledScheduledProcesses &&
      Number.isSafeInteger(processSampleAfterMs) &&
      processSampleAfterMs > 0 &&
      record.elapsedMs >= processSampleAfterMs
    if (baseline || lowFree || growth) {
      if (lowFree) smallestDiskPressureTier = pressureTier
      if (growth) sampledDiskGrowth = true
      record.diskUsage = {
        triggers: [baseline && 'baseline', lowFree && 'low_free', growth && 'growth'].filter(
          Boolean
        ),
        ...diskUsage(baseline && !lowFree ? 1 : 4),
      }
    }
    if (lowFree || growth || scheduled) {
      if (scheduled) sampledScheduledProcesses = true
      record.openDeletedDiskFiles = {
        triggers: [lowFree && 'low_free', growth && 'growth', scheduled && 'scheduled'].filter(
          Boolean
        ),
        ...openDeletedDiskFiles(child?.pid, statSync('.').dev),
      }
    }
    record.linux = Object.fromEntries(
      [
        ['memory', '/proc/meminfo'],
        ['cpuPressure', '/proc/pressure/cpu'],
        ['memoryPressure', '/proc/pressure/memory'],
        ['ioPressure', '/proc/pressure/io'],
        ['cgroupCpuLimit', '/sys/fs/cgroup/cpu.max'],
        ['cgroupCpuUsage', '/sys/fs/cgroup/cpu.stat'],
        ['cgroupMemoryLimit', '/sys/fs/cgroup/memory.max'],
        ['cgroupMemoryUsage', '/sys/fs/cgroup/memory.current'],
        ['cgroupMemoryPeak', '/sys/fs/cgroup/memory.peak'],
        ['cgroupMemoryEvents', '/sys/fs/cgroup/memory.events'],
        ['cgroupIo', '/sys/fs/cgroup/io.stat'],
      ].map(([name, path]) => [name, readMetric(path)])
    )
  }
  if (
    process.env.RUNNER_PROCESS_DIAGNOSTICS === '1' &&
    (phase !== 'interval' || sampleIntervalMs >= 1000)
  ) {
    try {
      record.processes = execFileSync('ps', ['-eo', 'pid,ppid,ni,pri,pcpu,stat,etime,comm'], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 256 * 1024,
      })
    } catch (error) {
      record.processes = { unavailable: error.code ?? error.name }
    }
  }
  previousCpu = currentCpu
  const line = JSON.stringify(record)
  appendFileSync(logPath, `${line}\n`)
  console.log(`[runner-resources] ${line}`)
}

sample('start')
child = spawn(command, args, { stdio: 'inherit' })
let expectedSampleAt = performance.now() + sampleIntervalMs
const timer = setInterval(() => {
  const sampledAt = performance.now()
  sample('interval', undefined, Math.max(0, sampledAt - expectedSampleAt))
  expectedSampleAt = sampledAt + sampleIntervalMs
}, sampleIntervalMs)
const signalHandlers = new Map(
  ['SIGINT', 'SIGTERM'].map(signal => {
    const handler = () => child.kill(signal)
    process.on(signal, handler)
    return [signal, handler]
  })
)

let spawnError
child.on('error', error => {
  spawnError = error
  console.error(`[runner-resources] Command failed to start: ${error.code}`)
})
child.on('close', (code, signal) => {
  clearInterval(timer)
  for (const [name, handler] of signalHandlers) process.off(name, handler)
  sample('end', code)
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = spawnError ? 127 : code
})
