import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { waitForClosedStartupSplash } from './modules/native-window-state.mjs'

const execute = promisify(execFile)
const CHECKPOINTS = new Set([
  'idle-executor-requests',
  'streaming-conversation-switching',
  'executor-stream-recovery',
])
const PROCESS_ROLES = ['Renderer', 'Executor']

export function readLinuxCpuCounters(pid, stat) {
  // comm is parenthesized and can itself contain spaces and closing parentheses.
  const commandEnd = stat.lastIndexOf(')')
  assert.ok(stat.startsWith(`${pid} (`) && commandEnd > stat.indexOf('('), 'Invalid process stat')
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)
  const [userTicks, systemTicks, startedAt] = [fields[11], fields[12], fields[19]].map(Number)
  assert.ok(
    [userTicks, systemTicks, startedAt].every(Number.isSafeInteger) &&
      userTicks >= 0 &&
      systemTicks >= 0 &&
      startedAt > 0,
    'Invalid CPU or process start counters'
  )
  return { pid, startedAt, ticks: userTicks + systemTicks }
}

async function sampleCpu(control) {
  const snapshot = JSON.parse(
    await control.command('getOwnedProcessSnapshot', 'body', {
      value: JSON.stringify({ fresh: true }),
    })
  )
  const renderers = snapshot.processes.filter(
    record => record.source === 'electron' && record.kind === 'window'
  )
  const executors = snapshot.processes.filter(
    record => record.kind === 'host-service' && record.owner.key === 'executor'
  )
  assert.ok(renderers.length, 'No Electron Renderer was reported')
  assert.equal(executors.length, 1, 'Expected one desktop Executor')
  const read = async ({ pid }) =>
    readLinuxCpuCounters(pid, await readFile(`/proc/${pid}/stat`, 'utf8'))
  const [Renderer, Executor] = await Promise.all([
    Promise.all(renderers.map(read)),
    Promise.all(executors.map(read)),
  ])
  return { Renderer, Executor }
}

export function desktopCpuMetrics(before, after, ticksPerSecond) {
  assert.ok(Number.isSafeInteger(ticksPerSecond) && ticksPerSecond > 0, 'Invalid CLK_TCK')
  return PROCESS_ROLES.map(role => {
    const initial = new Map(before[role].map(process => [process.pid, process]))
    assert.equal(initial.size, after[role].length, `${role} process count changed`)
    let ticks = 0
    for (const process of after[role]) {
      const start = initial.get(process.pid)
      assert.ok(start && start.startedAt === process.startedAt, `${role} process identity changed`)
      assert.ok(process.ticks >= start.ticks, `${role} CPU counter moved backwards`)
      ticks += process.ticks - start.ticks
      initial.delete(process.pid)
    }
    return { name: `${role} CPU time`, unit: 'ms', value: (ticks * 1000) / ticksPerSecond }
  })
}

export function instrumentDesktopCpuBenchmark(scenario, checkpoint) {
  const directory = process.env.WEWORK_E2E_CPU_BENCHMARK_DIR
  if (!directory || process.platform !== 'linux' || !CHECKPOINTS.has(checkpoint)) return

  const verify = scenario.verify
  scenario.verify = async function (control) {
    // The startup splash owns a transient renderer outside these workloads.
    await waitForClosedStartupSplash(control)
    const { stdout } = await execute('getconf', ['CLK_TCK'], { timeout: 2000 })
    const before = await sampleCpu(control)
    const result = await verify.call(this, control)
    const after = await sampleCpu(control)
    const metrics = desktopCpuMetrics(before, after, Number(stdout.trim()))
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${checkpoint}.json`), `${JSON.stringify(metrics)}\n`, {
      flag: 'wx',
    })
    return result
  }
}
