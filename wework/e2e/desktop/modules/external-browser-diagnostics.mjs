import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

async function diskWaitDetails(root, task, read) {
  const [kernelStack, systemCall, maps] = await Promise.all([
    read(join(task, 'stack')),
    read(join(task, 'syscall')),
    read(join(root, 'maps')),
  ])
  const address = systemCall.match(/0x[0-9a-f]+\s*$/i)?.[0]?.trim()
  let instructionFile = null
  if (address) {
    const pointer = BigInt(address)
    for (const line of maps.split('\n')) {
      const region = line.match(/^([0-9a-f]+)-([0-9a-f]+)\s+\S+\s+\S+\s+\S+\s+\S+\s*(.*)$/i)
      if (region && pointer >= BigInt(`0x${region[1]}`) && pointer < BigInt(`0x${region[2]}`)) {
        instructionFile = region[3] || '[anonymous]'
        break
      }
    }
  }
  return { kernelStack: kernelStack.trim(), systemCall: systemCall.trim(), instructionFile }
}

function processFaults(stat) {
  // The comm field can contain spaces and parentheses; numeric fields follow its last ')'.
  const end = stat.lastIndexOf(')')
  if (end === -1) return { unavailable: stat.trim() }
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/)
  const minor = Number(fields[7])
  const major = Number(fields[9])
  return Number.isFinite(minor) && Number.isFinite(major)
    ? { minor, major }
    : { unavailable: 'Invalid process fault counters' }
}

// Read only this fixture's descendants, never command lines or environment variables.
export async function sampleBrowserProcesses(pid, procRoot = '/proc') {
  const read = async path => readFile(path, 'utf8').catch(error => `<${error.code}>`)
  const pending = [String(pid)]
  const seen = new Set()
  const processes = []
  while (pending.length && seen.size < 32) {
    const current = pending.shift()
    if (seen.has(current)) continue
    seen.add(current)
    const root = join(procRoot, current)
    const tids = await readdir(join(root, 'task')).catch(() => [])
    const threads = await Promise.all(
      tids.slice(0, 64).map(async tid => {
        const task = join(root, 'task', tid)
        const [name, waitChannel, scheduling, children] = await Promise.all(
          ['comm', 'wchan', 'schedstat', 'children'].map(file => read(join(task, file)))
        )
        pending.push(
          ...children
            .trim()
            .split(/\s+/)
            .filter(value => /^\d+$/.test(value))
        )
        return {
          tid,
          name: name.trim(),
          waitChannel: waitChannel.trim(),
          scheduling: scheduling.trim(),
          ...(waitChannel.trim().startsWith('folio_wait')
            ? { diskWait: await diskWaitDetails(root, task, read) }
            : {}),
        }
      })
    )
    const [status, stat, fileIO] = await Promise.all(
      ['status', 'stat', 'io'].map(file => read(join(root, file)))
    )
    processes.push({ pid: current, status, faults: processFaults(stat), fileIO, threads })
  }
  return processes
}

export function recordBrowserStartup(pid, resultDir) {
  const started = Date.now()
  const samples = []
  let sampling = Promise.resolve()
  let busy = false
  const sample = () => {
    if (busy) return
    busy = true
    sampling = sampling.then(async () => {
      try {
        samples.push({
          elapsedMs: Date.now() - started,
          processes: await sampleBrowserProcesses(pid),
        })
      } catch (error) {
        samples.push({ elapsedMs: Date.now() - started, error: String(error) })
      } finally {
        busy = false
      }
    })
  }
  sample()
  const timer = setInterval(sample, 500)
  return async () => {
    clearInterval(timer)
    await sampling
    await writeFile(
      join(resultDir, 'external-browser-scheduling.json'),
      JSON.stringify(samples, null, 2)
    )
  }
}
