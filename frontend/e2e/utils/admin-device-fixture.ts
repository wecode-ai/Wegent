import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

const PREFIX = 'admin-device-fixture:'
const ACTION_TIMEOUT_MS = 30_000

export function startAdminDeviceFixture(
  child: ChildProcessWithoutNullStreams = spawn(
    'uv',
    ['run', '--no-sync', 'python', '-m', 'tests.e2e_admin_device_fixture', '--serve'],
    {
      cwd: resolve(__dirname, '../../../backend'),
      env: { ...process.env, PYTHONPATH: '..:.' },
      stdio: 'pipe',
    }
  )
) {
  const output = createInterface({ input: child.stdout })
  const lines = output[Symbol.asyncIterator]()
  let diagnostics = ''
  child.stderr.on('data', chunk => {
    diagnostics = `${diagnostics}${chunk}`.slice(-16 * 1024)
  })
  const closed = new Promise<Error | null>(accept => {
    child.once('error', accept)
    child.stdin.once('error', accept)
    child.once('close', code =>
      accept(code === 0 ? null : new Error(`Admin fixture exited ${code}: ${diagnostics}`))
    )
  })
  async function deadline<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            child.kill()
            reject(new Error('Admin fixture action exceeded its 30-second budget'))
          }, ACTION_TIMEOUT_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async function response(): Promise<void> {
    for (;;) {
      const line = await Promise.race([
        lines.next(),
        closed.then(error => {
          throw error ?? new Error('Admin fixture closed before its response')
        }),
      ])
      if (line.done) throw (await closed) ?? new Error('Admin fixture closed before its response')
      if (!line.value.startsWith(PREFIX)) continue
      if (JSON.parse(line.value.slice(PREFIX.length)).ok !== true)
        throw new Error('Admin fixture rejected its action')
      return
    }
  }
  let queued = Promise.resolve()
  return {
    run(action: { action: string; record_id: number; suffix: string }): Promise<void> {
      const next = queued.then(() => {
        const started = performance.now()
        child.stdin.write(`${JSON.stringify(action)}\n`)
        return deadline(response()).then(() => {
          console.log(
            `[admin-device-fixture] ${action.action} durationMs=${Math.round(performance.now() - started)}`
          )
        })
      })
      queued = next.catch(() => undefined)
      return next
    },
    async close(): Promise<void> {
      await queued
      child.stdin.end()
      const error = await deadline(closed)
      output.close()
      if (error) throw error
    },
  }
}
