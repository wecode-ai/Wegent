import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { collectWindowsProcessIdentity, processInstanceMatches } from './process-lifecycle.mjs'

const execFileAsync = promisify(execFile)
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

function linuxIdentity(pid, stat, bootId) {
  const commandStart = stat.indexOf('(')
  const commandEnd = stat.lastIndexOf(')')
  assert.equal(Number(stat.slice(0, stat.indexOf(' '))), pid, 'Unexpected /proc process PID')
  assert.ok(commandStart > 0 && commandEnd > commandStart, 'Invalid /proc process command')
  // The parenthesized comm field can contain spaces and closing parentheses.
  const startTicks = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)[19]
  assert.match(startTicks ?? '', /^\d+$/, 'Missing /proc process starttime ticks')
  assert.ok(BigInt(startTicks) > 0n, 'Invalid /proc process starttime ticks')
  assert.match(bootId, UUID, 'Missing Linux boot identity')
  return { pid, creationToken: `linux:${bootId.toLowerCase()}:${startTicks}` }
}

async function darwinIdentity(pid, executeFile) {
  let stdout
  try {
    const result = await executeFile('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    })
    stdout = result.stdout
  } catch (error) {
    // ps exits 1 without output when the requested process no longer exists.
    if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return null
    throw error
  }
  const started = stdout.trim().replace(/\s+/g, ' ')
  assert.match(
    started,
    /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/,
    'Missing macOS process creation time'
  )
  assert.ok(Number.isFinite(Date.parse(started)), 'Invalid macOS process creation time')
  // lstart reads the kernel creation time at second precision; it does not derive it from etime.
  return { pid, creationToken: `darwin:${started}` }
}

/** Read creation identity in the runner's PID namespace, independently of display snapshots. */
export async function collectProcessInstanceIdentity(
  pid,
  {
    platform = process.platform,
    readText = readFile,
    executeFile = execFileAsync,
    readWindowsIdentity = collectWindowsProcessIdentity,
  } = {}
) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Process identity requires a positive PID')
  if (platform === 'linux') {
    const bootId = (await readText('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    let stat
    try {
      stat = await readText(`/proc/${pid}/stat`, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return null
      throw error
    }
    return linuxIdentity(pid, stat, bootId)
  }
  if (platform === 'darwin') return darwinIdentity(pid, executeFile)
  if (platform === 'win32') {
    const identity = await readWindowsIdentity(pid)
    if (identity === null) return null
    processInstanceMatches(identity, identity)
    assert.equal(identity.Id, pid, 'Unexpected Windows process PID')
    return { pid, creationToken: `win32:${identity.StartedAt}` }
  }
  throw new Error(`Unsupported process identity platform: ${platform}`)
}
