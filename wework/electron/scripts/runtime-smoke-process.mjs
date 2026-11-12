import { createInterface } from 'node:readline'
import { once } from 'node:events'

export async function authenticatedBrowserRequest(processHandle, origin) {
  const lines = createInterface({ input: processHandle.stdio[5] })
  let url
  try {
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(30_000) })
    url = new URL(JSON.parse(line).url)
  } finally {
    lines.close()
  }
  if (url.origin !== origin || url.pathname !== '/' || !url.searchParams.get('token')) {
    throw new Error('Invalid private DSH browser authentication response')
  }
  const exchange = await fetch(url, { redirect: 'manual' })
  const cookie = exchange.headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .join('; ')
  await exchange.arrayBuffer()
  if (![204, 302].includes(exchange.status) || !cookie)
    throw new Error('DSH browser authentication failed')
  return (target, init = {}) => {
    if (new URL(target).origin !== origin) throw new Error('Unexpected DSH request origin')
    const headers = new Headers(init.headers)
    headers.set('cookie', cookie)
    return fetch(target, { ...init, headers })
  }
}

export async function terminate(processHandle) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return
  const exited = new Promise(resolvePromise => processHandle.once('exit', resolvePromise))
  try {
    if (process.platform === 'win32') processHandle.kill()
    else if (processHandle.pid) process.kill(-processHandle.pid, 'SIGTERM')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  const timeout = new Promise(resolvePromise => setTimeout(resolvePromise, 2_000, 'timeout'))
  if ((await Promise.race([exited, timeout])) !== 'timeout') return
  try {
    if (process.platform === 'win32') processHandle.kill('SIGKILL')
    else if (processHandle.pid) process.kill(-processHandle.pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  await exited
}
