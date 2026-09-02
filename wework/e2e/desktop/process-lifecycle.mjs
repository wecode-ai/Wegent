import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

const PROCESS_STOP_TIMEOUT_MS = 10_000
const PROCESS_GROUP_GRACE_PERIOD_MS = 1_000
const PROCESS_GROUP_POLL_INTERVAL_MS = 25
const DEAD_LINUX_PROCESS_STATES = new Set(['Z', 'X', 'x'])

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

function withTimeout(promise, timeoutMs, message) {
  let timeout
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout))
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return withTimeout(
    new Promise(resolvePromise => {
      const onExit = () => resolvePromise()
      child.once('exit', onExit)
      if (child.exitCode !== null || child.signalCode !== null) {
        child.off('exit', onExit)
        resolvePromise()
      }
    }),
    timeoutMs,
    `Timed out waiting for process ${child.pid ?? 'unknown'} to exit`
  )
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
      return
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
    stdio: 'ignore',
    windowsHide: true,
  })
  await new Promise((resolvePromise, reject) => {
    killer.once('error', reject)
    killer.once('close', resolvePromise)
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
