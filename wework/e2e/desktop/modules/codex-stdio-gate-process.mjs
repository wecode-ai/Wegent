import { spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// A byte-preserving JSON-lines relay around the real, isolated Codex binary.
// Hold a selected original frame; no request, response or notification is synthesized.
const [binary, directory, ...args] = process.argv.slice(2)
const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
const timers = new Set()

if (!args.includes('app-server')) {
  process.stdin.pipe(child.stdin)
  child.stdout.pipe(process.stdout)
} else {
  createInterface({ input: process.stdin })
    .on('line', line => {
      const request = JSON.parse(line)
      if (request.id !== undefined && request.method)
        pending.set(String(request.id), request.method)
      child.stdin.write(`${line}\n`)
    })
    .on('close', () => child.stdin.end())

  createInterface({ input: child.stdout }).on('line', line => {
    const response = JSON.parse(line)
    const method = pending.get(String(response.id))
    pending.delete(String(response.id))
    const armed = join(directory, 'armed')
    const rule = existsSync(armed) ? JSON.parse(readFileSync(armed, 'utf8')) : null
    const matches =
      rule?.kind === 'overload-terminal'
        ? response.method === 'turn/completed' && response.params?.turn?.status === 'failed'
        : rule?.kind === 'model-list' && method === 'model/list'
    if (!matches) {
      process.stdout.write(`${line}\n`)
      return
    }
    renameSync(armed, join(directory, 'claimed'))
    writeFileSync(
      join(directory, 'held.tmp'),
      JSON.stringify({
        method,
        id: response.id,
        notification: response.method,
        turnId: response.params?.turn?.id,
        status: response.params?.turn?.status,
        capturedAt: Date.now(),
        modelIds: (response.result?.data ?? []).map(model => model.id),
      })
    )
    renameSync(join(directory, 'held.tmp'), join(directory, 'held.json'))
    const timer = setInterval(() => {
      if (!existsSync(join(directory, 'released'))) return
      clearInterval(timer)
      timers.delete(timer)
      process.stdout.write(`${line}\n`)
    }, 10)
    timers.add(timer)
  })
}

child.once('error', error => {
  console.error(error.message)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  for (const timer of timers) clearInterval(timer)
  process.exit(code ?? (signal ? 1 : 0))
})
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
