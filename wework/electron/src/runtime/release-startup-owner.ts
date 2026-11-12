import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Resolve existing ancestors too, so first launch shares the identity of every alias. */
async function canonicalReleaseRoot(root: string): Promise<string> {
  let existing = resolve(root)
  const missing: string[] = []
  for (;;) {
    try {
      return join(await realpath(existing), ...missing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      missing.unshift(basename(existing))
      existing = parent
    }
  }
}

async function privateLockDirectory(path: string, uid: number): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (
    !info.isDirectory() ||
    (process.platform !== 'win32' && (info.uid !== uid || (info.mode & 0o077) !== 0))
  ) {
    throw new Error('The release startup lock directory must be private and user-owned')
  }
}

/** Serialize bootstrap transactions without consuming application launch requests. */
export async function acquireReleaseStartup(
  root: string,
  launcher: string,
  onLost: (error: Error) => void
): Promise<() => Promise<void>> {
  const identity = await canonicalReleaseRoot(root)
  const key = createHash('sha256').update(identity).digest('hex')
  // Native account metadata is independent of per-process HOME/TMPDIR overrides.
  const account = userInfo()
  const namespace = join(account.homedir, '.wegent', 'release-startup')
  await privateLockDirectory(namespace, account.uid)
  const profile = join(namespace, key)
  await privateLockDirectory(profile, account.uid)
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
