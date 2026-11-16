import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { stopProcessGroup } from '../process-lifecycle.mjs'

/** Real package-owned Codex with isolated data and no inherited credentials. */
export async function startNativeAppServer({
  binary,
  home,
  workspace,
  config = [],
  timeoutMs = 10_000,
}) {
  const child = spawn(binary, [...config.flatMap(value => ['-c', value]), 'app-server'], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: home,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
    },
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  let sequence = 0
  const pending = new Map()
  const notifications = []
  let failure
  const rejectPending = error => {
    failure ??= error
    for (const entry of pending.values()) entry.reject(failure)
    pending.clear()
  }
  child.once('error', rejectPending)
  child.stdin.on('error', rejectPending)
  child.once('exit', (code, signal) =>
    rejectPending(new Error(`Native app-server exited (${code ?? signal})`))
  )
  lines.on('line', line => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      rejectPending(new Error('Native app-server emitted invalid JSON'))
      return
    }
    const entry = pending.get(message.id)
    if (entry) {
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    } else if (message.method) notifications.push(message)
  })
  async function rpc(method, params) {
    if (failure) throw failure
    const id = ++sequence
    let timer
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Native ${method} timed out`)), timeoutMs)
        pending.set(id, { resolve, reject })
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      })
    } finally {
      clearTimeout(timer)
      pending.delete(id)
    }
  }
  const stop = async () => {
    await stopProcessGroup(child)
    lines.close()
  }
  try {
    await rpc('initialize', {
      clientInfo: { name: 'upgrade_native_fixture', version: '1' },
      capabilities: { experimentalApi: true },
    })
    child.stdin.write('{"method":"initialized","params":{}}\n')
    return { child, rpc, stop, notifications }
  } catch (error) {
    await stop()
    throw error
  }
}
