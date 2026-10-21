import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, statfsSync } from 'node:fs'
import { availableParallelism, cpus, freemem, loadavg, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'

const [command, ...args] = process.argv.slice(2)
if (!command) throw new Error('A command is required')

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
function sample(phase, exitCode) {
  const currentCpu = cpuTimes()
  const elapsed = currentCpu.total - previousCpu.total
  const disk = statfsSync('.')
  const record = {
    timestamp: new Date().toISOString(),
    phase,
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
  }
  if (process.platform === 'linux') {
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
  if (process.env.RUNNER_PROCESS_DIAGNOSTICS === '1') {
    try {
      record.processes = execFileSync('ps', ['-eo', 'pid,ppid,stat,etime,comm'], {
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
const timer = setInterval(() => sample('interval'), 15_000)
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
