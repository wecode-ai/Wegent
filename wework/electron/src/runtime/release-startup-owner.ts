import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** Serialize bootstrap transactions without consuming application launch requests. */
export async function acquireReleaseStartup(
  root: string,
  launcher: string,
  onLost: (error: Error) => void
): Promise<() => Promise<void>> {
  let identity = resolve(root)
  try {
    identity = await realpath(identity)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const key = createHash('sha256').update(identity).digest('hex')
  const profile = join(tmpdir(), 'wework-release-startup', key)
  await mkdir(profile, { recursive: true, mode: 0o700 })
  return acquireNativeLock(launcher, join(profile, 'startup.lock'), onLost)
}

async function acquireNativeLock(
  launcher: string,
  path: string,
  onLost: (error: Error) => void
): Promise<() => Promise<void>> {
  const child = spawn(launcher, ['--startup-lock', path], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let acquired = false
  let releasing = false
  let lost = false
  const failure = new Error('Native release startup lock was lost')
  const ended = new Promise<number | null>(accept => child.once('close', accept))
  const lose = (error: Error): void => {
    if (lost) return
    lost = true
    onLost(error)
  }
  child.stderr.resume()
  child.stdin.on('error', error => {
    if (acquired && !releasing) lose(error)
  })
  child.once('close', () => {
    if (acquired && !releasing) lose(failure)
  })
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((accept, reject) => {
      let output = ''
      timeout = setTimeout(() => reject(new Error('Native release startup lock timed out')), 60_000)
      child.once('error', reject)
      void ended.then(() => reject(failure))
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        output += chunk
        if (output === 'locked\n' || output === 'locked\r\n') {
          acquired = true
          accept()
        } else if (output.includes('\n') || output.length > 64) reject(failure)
      })
    })
  } catch (error) {
    child.kill('SIGKILL')
    child.stdin.destroy()
    await ended
    throw error
  } finally {
    clearTimeout(timeout)
  }
  return async () => {
    if (lost) throw failure
    if (releasing) throw new Error('Native release startup lock was already released')
    releasing = true
    child.stdin.end()
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
    try {
      if ((await ended) !== 0) throw failure
    } finally {
      clearTimeout(timeout)
    }
  }
}
