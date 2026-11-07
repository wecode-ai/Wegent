import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
        }
      })
    )
    processes.push({ pid: current, status: await read(join(root, 'status')), threads })
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
