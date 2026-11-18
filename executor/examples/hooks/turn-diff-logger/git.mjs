import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { copyFile, rm, stat, utimes } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'

export const BUFFER_BYTES = 64 * 1024

async function bounded(stream, truncate = false) {
  const chunks = []
  let bytes = 0
  for await (const chunk of stream) {
    const remaining = BUFFER_BYTES - bytes
    if (chunk.length > remaining && !truncate) throw new Error('Git metadata exceeds 64 KiB')
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining)
      chunks.push(retained)
      bytes += retained.length
    }
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/[\r\n]+$/, '')
}

function spawnGit(cwd, args, { index, input, hooks } = {}) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
  )
  return spawn(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.longpaths=true',
      ...(hooks ? ['-c', `core.hooksPath=${hooks}`] : []),
      ...args,
    ],
    {
      cwd,
      env: { ...environment, ...(index ? { GIT_INDEX_FILE: index } : {}) },
      stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }
  )
}

function exitStatus(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

function checkExit(result, args, stderr) {
  if (result.code === 0) return
  const error = new Error(`git ${args[0]} failed (${result.code ?? result.signal}): ${stderr}`)
  error.gitExitCode = result.code
  throw error
}

export async function* gitStream(cwd, args, options = {}) {
  const child = spawnGit(cwd, args, options)
  const completed = Promise.all([
    exitStatus(child),
    bounded(child.stderr, true),
    options.input == null ? undefined : pipeline(Readable.from([options.input]), child.stdin),
  ])
  // Attach immediately: a caller can pause this generator while sending HTTP.
  completed.catch(() => {})
  try {
    for await (const bytes of child.stdout) yield bytes
    const [result, stderr] = await completed
    checkExit(result, args, stderr)
  } finally {
    child.kill('SIGKILL')
    await completed.catch(() => {})
  }
}

export async function git(cwd, args, { index, output, input, hooks } = {}) {
  const child = spawnGit(cwd, args, { index, input, hooks })
  const exited = exitStatus(child)
  try {
    const [stdout, stderr, result] = await Promise.all([
      output
        ? pipeline(
            child.stdout,
            createWriteStream(output, {
              flags: 'wx',
              mode: 0o600,
              highWaterMark: BUFFER_BYTES,
            })
          )
        : bounded(child.stdout),
      bounded(child.stderr, true),
      exited,
      input == null ? undefined : pipeline(Readable.from([input]), child.stdin),
    ])
    checkExit(result, args, stderr)
    return stdout
  } catch (error) {
    child.kill('SIGKILL')
    await exited.catch(() => {})
    throw error
  }
}

export async function repository(cwd) {
  try {
    if ((await git(cwd, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return null
    return await git(cwd, ['rev-parse', '--show-toplevel'])
  } catch (error) {
    if (error.gitExitCode === 128) return null
    throw error
  }
}

export async function snapshot(workspace, directory, hooks) {
  const index = join(directory, 'snapshot.index')
  await rm(index, { force: true })
  const source = await git(workspace, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'index',
  ])
  let timestamp = 0
  let copied = false
  try {
    timestamp = Math.floor((await stat(source)).mtimeMs / 1000)
    await copyFile(source, index)
    copied = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const options = { index, hooks }
  try {
    await git(
      workspace,
      copied ? ['update-index', '--no-split-index'] : ['read-tree', '--empty'],
      options
    )
    // Preserve Git's racy-index rehash rule when copying cached file stats.
    await utimes(index, timestamp, timestamp)
    await git(workspace, ['add', '--all', '--', '.'], options)
    return await git(workspace, ['write-tree'], options)
  } finally {
    await rm(index, { force: true })
  }
}

export async function remoteUrl(workspace, hooks) {
  let value
  try {
    value = await git(workspace, ['config', '--get', 'remote.origin.url'], {
      hooks,
    })
  } catch (error) {
    if (error.gitExitCode === 1) return null
    throw error
  }
  if (!value) return null
  if (!value.includes('://')) return value
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid Git remote URL')
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString()
}

export async function pin(workspace, reference, tree, hooks) {
  await git(workspace, ['update-ref', reference, tree], { hooks })
}

export async function unpin(workspace, reference, hooks) {
  await git(workspace, ['update-ref', '-d', reference], { hooks })
}

async function referenceValue(workspace, reference, hooks) {
  try {
    return await git(workspace, ['rev-parse', '--verify', '--quiet', reference], { hooks })
  } catch (error) {
    if (error.gitExitCode === 1) return null
    throw error
  }
}

// Git's compare-and-swap owns the lock; only a confirmed dead PID is reclaimed.
export async function withLock(workspace, reference, hooks, operation, { wait = true } = {}) {
  const owner = await git(workspace, ['hash-object', '-w', '--stdin'], {
    input: JSON.stringify({ pid: process.pid, token: randomUUID() }),
    hooks,
  })
  const deadline = Date.now() + 30000
  while (true) {
    const current = await referenceValue(workspace, reference, hooks)
    let available = current == null
    if (current) {
      const { pid } = JSON.parse(await git(workspace, ['cat-file', 'blob', current], { hooks }))
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid lock owner')
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') available = true
        else if (error.code !== 'EPERM') throw error
      }
    }
    if (available) {
      try {
        await git(
          workspace,
          ['update-ref', reference, owner, current ?? '0'.repeat(owner.length)],
          { hooks }
        )
        break
      } catch (error) {
        if ((await referenceValue(workspace, reference, hooks)) === current) throw error
      }
    }
    if (!wait) return false
    if (Date.now() >= deadline) throw new Error('Hook state is locked')
    await delay(25)
  }
  try {
    await operation()
  } finally {
    await git(workspace, ['update-ref', '-d', reference, owner], { hooks })
  }
  return true
}
