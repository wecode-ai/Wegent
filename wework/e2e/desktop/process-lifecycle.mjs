import { execFile, spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'

const PROCESS_STOP_TIMEOUT_MS = 10_000
const PROCESS_GROUP_GRACE_PERIOD_MS = 1_000
const PROCESS_GROUP_POLL_INTERVAL_MS = 25
const DEAD_LINUX_PROCESS_STATES = new Set(['Z', 'X', 'x'])
const execFileAsync = promisify(execFile)
// Use the same PowerShell runtime as the Windows E2E workflow.
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 30_000

function linuxProcessStateFromStat(stat) {
  const commandEnd = stat.lastIndexOf(')')
  if (commandEnd === -1) return null
  return (
    stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/)[0] ?? null
  )
}

export function processIsAliveFromLinuxStat(stat) {
  const state = linuxProcessStateFromStat(stat)
  if (state === null) return null
  return !DEAD_LINUX_PROCESS_STATES.has(state)
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  let wake
  let timeout
  const onExit = () => wake?.()
  child.once('exit', onExit)
  const startedAt = Date.now()
  try {
    while (child.exitCode === null && child.signalCode === null) {
      if (Number.isInteger(child.pid) && !processIsAlive(child.pid)) return
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `Timed out waiting for process ${child.pid ?? 'unknown'} to exit: ${JSON.stringify(processExitDiagnostics(child))}`
        )
      }
      await new Promise(resolvePromise => {
        wake = resolvePromise
        timeout = setTimeout(resolvePromise, PROCESS_GROUP_POLL_INTERVAL_MS)
      })
      clearTimeout(timeout)
    }
  } finally {
    clearTimeout(timeout)
    child.off('exit', onExit)
  }
}

function processExitDiagnostics(child) {
  const diagnostics = { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }
  if (process.platform !== 'linux' || !Number.isInteger(child.pid)) return diagnostics
  try {
    const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8')
    const fields = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/)
    diagnostics.linux = {
      state: fields[0],
      parentProcessId: fields[1],
      processGroupId: fields[2],
      sessionId: fields[3],
    }
  } catch (error) {
    diagnostics.linux = { readError: error.code ?? String(error) }
  }
  return diagnostics
}

export function processGroupHasLiveMembersFromLinuxStats(stats, processGroupId) {
  let foundProcessGroupMember = false
  for (const stat of stats) {
    const commandEnd = stat.lastIndexOf(')')
    if (commandEnd === -1) continue
    const fields = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/)
    const state = linuxProcessStateFromStat(stat)
    const statProcessGroupId = Number.parseInt(fields[2], 10)
    if (statProcessGroupId !== processGroupId) continue
    foundProcessGroupMember = true
    if (!DEAD_LINUX_PROCESS_STATES.has(state)) return true
  }
  return foundProcessGroupMember ? false : null
}

function inspectLinuxProcessGroup(processGroupId) {
  let processEntries
  try {
    processEntries = readdirSync('/proc', { withFileTypes: true })
  } catch {
    return null
  }

  const stats = []
  for (const entry of processEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    try {
      stats.push(readFileSync(`/proc/${entry.name}/stat`, 'utf8'))
    } catch {
      // Processes can exit while /proc is being inspected.
    }
  }
  return processGroupHasLiveMembersFromLinuxStats(stats, processGroupId)
}

function inspectLinuxProcess(processId) {
  try {
    return processIsAliveFromLinuxStat(readFileSync(`/proc/${processId}/stat`, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    return null
  }
}

export function processIsAlive(processId) {
  try {
    process.kill(processId, 0)
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code !== 'EPERM') throw error
  }
  if (process.platform === 'linux') {
    const isAlive = inspectLinuxProcess(processId)
    if (isAlive !== null) return isAlive
  }
  return true
}

export function processInstanceMatches(expected, actual) {
  const validate = identity => {
    if (
      !identity ||
      !Number.isInteger(identity.Id) ||
      identity.Id <= 0 ||
      typeof identity.ProcessName !== 'string' ||
      !identity.ProcessName ||
      typeof identity.StartedAt !== 'string' ||
      !Number.isFinite(Date.parse(identity.StartedAt))
    ) {
      throw new Error('Process identity requires a PID, process name and creation time')
    }
  }
  validate(expected)
  if (actual === null) return false
  validate(actual)
  return (
    expected.Id === actual.Id &&
    expected.ProcessName === actual.ProcessName &&
    expected.StartedAt === actual.StartedAt
  )
}

export async function collectWindowsProcessIdentity(processId) {
  if (process.platform !== 'win32') return null
  if (!Number.isInteger(processId) || processId <= 0) {
    throw new Error('Process identity diagnostics require a positive process ID')
  }
  const startedAt = Date.now()
  const { stdout } = await execFileAsync(
    'pwsh.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference = 'Stop'; @(Get-Process -Id ${processId} -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, @{Name='StartedAt'; Expression={$_.StartTime.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress`,
    ],
    {
      encoding: 'utf8',
      timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    }
  ).catch(error => {
    throw new Error(
      `Windows process identity query failed: ${JSON.stringify({
        processId,
        elapsedMs: Date.now() - startedAt,
        code: error.code ?? null,
        signal: error.signal ?? null,
        killed: error.killed ?? false,
      })}`,
      { cause: error }
    )
  })
  console.log('[desktop-e2e] Windows process identity query', {
    processId,
    elapsedMs: Date.now() - startedAt,
  })
  const identity = stdout.trim() ? JSON.parse(stdout) : null
  if (identity !== null) processInstanceMatches(identity, identity)
  return identity
}

export function processGroupIsAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0)
    if (process.platform === 'linux') {
      const hasLiveMembers = inspectLinuxProcessGroup(processGroupId)
      if (hasLiveMembers !== null) return hasLiveMembers
    }
    return true
  } catch (error) {
    // A reaped descendant can briefly retain the group ID under a process we
    // cannot signal. Do not wait for, or signal, a potentially reused group.
    if (error?.code === 'ESRCH' || error?.code === 'EPERM') return false
    throw error
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!processGroupIsAlive(processGroupId)) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, PROCESS_GROUP_POLL_INTERVAL_MS))
  }
  return !processGroupIsAlive(processGroupId)
}

export async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    await waitForProcessExit(child, PROCESS_STOP_TIMEOUT_MS)
  } catch {
    child.kill('SIGKILL')
    await waitForProcessExit(child, PROCESS_STOP_TIMEOUT_MS)
  }
}

export async function stopProcessGroup(child) {
  if (!child) return
  if (process.platform === 'win32') {
    await stopWindowsProcessTree(child)
    return
  }
  if (!Number.isInteger(child.pid)) {
    await stopProcess(child)
    return
  }

  const processGroupId = child.pid
  signalProcessGroup(processGroupId, 'SIGTERM')
  if (child.exitCode === null && child.signalCode === null) {
    try {
      await waitForProcessExit(child, PROCESS_STOP_TIMEOUT_MS)
    } catch {
      signalProcessGroup(processGroupId, 'SIGKILL')
      await waitForProcessExit(child, PROCESS_STOP_TIMEOUT_MS)
    }
  }
  if (await waitForProcessGroupExit(processGroupId, PROCESS_GROUP_GRACE_PERIOD_MS)) return
  signalProcessGroup(processGroupId, 'SIGKILL')
  if (!(await waitForProcessGroupExit(processGroupId, PROCESS_STOP_TIMEOUT_MS))) {
    throw new Error(`Timed out waiting for process group ${processGroupId} to exit`)
  }
}

export function windowsTaskkillArguments(processId) {
  return ['/PID', String(processId), '/T', '/F']
}

async function stopWindowsProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || !Number.isInteger(child.pid)) return
  const killer = spawn('taskkill', windowsTaskkillArguments(child.pid), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  for (const stream of [killer.stdout, killer.stderr]) {
    stream.on('data', chunk => {
      output = `${output}${chunk}`.slice(-16 * 1024)
    })
  }
  await new Promise((resolvePromise, reject) => {
    killer.once('error', reject)
    killer.once('close', code => {
      console.log('[desktop-e2e] Windows process tree termination', {
        processId: child.pid,
        code,
        output: output.trim(),
      })
      resolvePromise()
    })
  })
  await waitForProcessExit(child, PROCESS_STOP_TIMEOUT_MS)
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}
