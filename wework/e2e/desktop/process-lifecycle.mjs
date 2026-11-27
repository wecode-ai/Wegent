import { execFile, execFileSync, spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { ownedProcessIdentityMatches, readNativeProcessIdentity } from './process-identity.mjs'

const PROCESS_STOP_TIMEOUT_MS = 10_000
const PROCESS_GROUP_GRACE_PERIOD_MS = 1_000
const PROCESS_GROUP_POLL_INTERVAL_MS = 25
const DEAD_LINUX_PROCESS_STATES = new Set(['Z', 'X', 'x'])
const execFileAsync = promisify(execFile)
// Use the same PowerShell runtime as the Windows E2E workflow.
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 30_000

/**
 * Every signal the desktop E2E harness delivers to an application process or
 * process group is logged with a self-contained timestamp. Chromium crash
 * lines in app.log use runner-local time, so these records allow attributing
 * each "Network service crashed" line to harness teardown or leaving it as an
 * unexplained event that needs further investigation.
 */
export function logDesktopE2eSignal(detail) {
  // The timestamp is spread last so a caller payload can never override it.
  console.log(`[desktop-e2e-signal] ${JSON.stringify({ ...detail, at: new Date().toISOString() })}`)
}

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

async function waitForProcessExit(child, timeoutMs, { requireExitEvent = false } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  let wake
  let timeout
  const onExit = () => wake?.()
  child.once('exit', onExit)
  const startedAt = Date.now()
  try {
    while (child.exitCode === null && child.signalCode === null) {
      // Windows PID probes can disappear before the native exit callback releases resources.
      if (
        !requireExitEvent &&
        process.platform !== 'win32' &&
        Number.isInteger(child.pid) &&
        !processIsAlive(child.pid)
      )
        return
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

export function processExitDiagnostics(child) {
  const diagnostics = { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }
  if (process.platform === 'darwin' && Number.isInteger(child.pid)) {
    try {
      diagnostics.macos = execFileSync(
        'ps',
        ['-p', String(child.pid), '-o', 'pid=,ppid=,pgid=,uid=,stat=,lstart=,comm='],
        { encoding: 'utf8', timeout: 1_000 }
      ).trim()
    } catch (error) {
      diagnostics.macos = { unavailable: error.code ?? error.status ?? error.name }
    }
  }
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
    try {
      const directory = `/proc/${child.pid}/task`
      const threadIds = readdirSync(directory)
        .filter(id => /^\d+$/.test(id))
        .sort((a, b) => Number(a) - Number(b))
      const read = path => {
        try {
          return readFileSync(path, 'utf8').trim()
        } catch (error) {
          return `unavailable:${error.code ?? error.name}`
        }
      }
      diagnostics.linux.threadCount = threadIds.length
      diagnostics.linux.threads = threadIds.slice(0, 64).map(id => ({
        id: Number(id),
        name: read(`${directory}/${id}/comm`),
        state: linuxProcessStateFromStat(read(`${directory}/${id}/stat`)),
        waitChannel: read(`${directory}/${id}/wchan`),
        kernelStack: read(`${directory}/${id}/stack`),
      }))
    } catch (error) {
      diagnostics.linux.threadReadError = error.code ?? error.name
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

export async function waitForOwnedProcessExit(
  snapshot,
  { timeoutMs = PROCESS_STOP_TIMEOUT_MS, isAlive, readIdentity } = {}
) {
  const targets = ownedProcessIdentities({ pid: snapshot.applicationPid }, snapshot)
  // Preserve callers that supply their own instance-aware liveness diagnostic.
  if (isAlive && !readIdentity) {
    await waitForProcessIdsExit(
      targets.map(target => target.pid),
      { timeoutMs, isAlive }
    )
    return
  }
  const state = createOwnedIdentityState(targets, readIdentity ?? readNativeProcessIdentity)
  if (process.platform === 'win32' && !readIdentity) {
    await waitForWindowsOwnedProcessExit(targets, timeoutMs)
    return
  }
  await waitForProcessIdsExit(
    targets.map(target => target.pid),
    { timeoutMs, isAlive: state.isAlive }
  )
}

async function waitForProcessIdsExit(pids, { timeoutMs, isAlive = processIsAlive }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const survivors = pids.filter(isAlive)
    if (survivors.length === 0) return
    if (Date.now() >= deadline)
      throw new OwnedProcessExitTimeoutError(
        `Owned application processes survived shutdown: ${survivors.join(', ')}`
      )
    await new Promise(accept => setTimeout(accept, PROCESS_GROUP_POLL_INTERVAL_MS))
  }
}

class OwnedProcessExitTimeoutError extends Error {}

export async function stopOwnedProcessTree(
  child,
  snapshot,
  { readIdentity = readNativeProcessIdentity } = {}
) {
  // Validate once, before shutdown can orphan descendants or age the snapshot.
  const targets = ownedProcessIdentities(child, snapshot)
  if (process.platform === 'win32') {
    await stopProcessGroup(child)
    await waitForWindowsOwnedProcessExit(targets, PROCESS_STOP_TIMEOUT_MS)
    return
  }
  const state = createOwnedIdentityState(targets, readIdentity, child)
  const signalSurvivors = (signal, selected = targets.toReversed()) => {
    const errors = []
    for (const { pid } of selected) {
      try {
        if (!state.isAlive(pid)) continue
        process.kill(pid, signal)
        logDesktopE2eSignal({ action: 'stop-owned-process', pid, signal })
      } catch (error) {
        if (error?.code !== 'ESRCH') errors.push(error)
      }
    }
    throwShutdownErrors(errors)
  }
  const errors = []
  // Pin descendants before their owner exits and they are reparented. Stopping
  // Chromium children first can make the live owner spawn unrecorded replacements.
  for (const { pid } of targets) {
    try {
      state.isAlive(pid)
    } catch (error) {
      errors.push(error)
    }
  }
  try {
    signalSurvivors('SIGTERM', [targets[0]])
    try {
      await waitForProcessIdsExit([child.pid], {
        timeoutMs: PROCESS_STOP_TIMEOUT_MS,
        isAlive: state.isAlive,
      })
    } catch (error) {
      if (!(error instanceof OwnedProcessExitTimeoutError)) throw error
      signalSurvivors('SIGKILL', [targets[0]])
      await waitForProcessIdsExit([child.pid], {
        timeoutMs: PROCESS_STOP_TIMEOUT_MS,
        isAlive: state.isAlive,
      })
    }
  } catch (error) {
    errors.push(error)
  }
  // Independent groups, including SQLite writers, still need their own signals.
  try {
    signalSurvivors('SIGTERM')
  } catch (error) {
    errors.push(error)
  }
  try {
    await stopProcessGroup(child, { isOwnedGroup: () => state.groupIsAlive(child.pid) })
  } catch (error) {
    errors.push(error)
  }
  try {
    try {
      await waitForProcessIdsExit(
        targets.map(target => target.pid),
        { timeoutMs: PROCESS_GROUP_GRACE_PERIOD_MS, isAlive: state.isAlive }
      )
    } catch (error) {
      if (!(error instanceof OwnedProcessExitTimeoutError)) errors.push(error)
      signalSurvivors('SIGKILL')
      await waitForProcessIdsExit(
        targets.map(target => target.pid),
        { timeoutMs: PROCESS_STOP_TIMEOUT_MS, isAlive: state.isAlive }
      )
    }
  } catch (error) {
    errors.push(error)
  }
  throwShutdownErrors(errors)
}

function throwShutdownErrors(errors) {
  const unique = [...new Set(errors)]
  if (unique.length === 1) throw unique[0]
  if (unique.length > 1)
    throw new AggregateError(
      unique,
      `Owned process shutdown failed: ${unique.map(error => error.message ?? String(error)).join('; ')}`
    )
}

function createOwnedIdentityState(targets, readIdentity, child) {
  const expected = new Map(targets.map(target => [target.pid, target]))
  const applicationPid = targets[0].pid
  const instances = new Map(
    targets
      .filter(target => target.instanceToken || target.source === 'native')
      .map(target => [target.pid, target])
  )
  const readOwned = (pid, visited = new Set()) => {
    if (expected.get(pid).exited) return null
    const actual = readIdentity(pid)
    if (actual === null) return null
    if (actual?.pid !== pid) return null
    if (
      !Number.isFinite(actual.startedAt) ||
      actual.startedAt <= 0 ||
      ![1, 1000].includes(actual.precisionMs)
    ) {
      throw new Error(`Process ${pid} has an unknown creation time`)
    }
    const pinned = instances.get(pid)
    if (pinned?.instanceToken) {
      if (!actual?.instanceToken)
        throw new Error(`Process ${pid} lost its native instance identity`)
      if (actual.instanceToken !== pinned.instanceToken) return null
      if (!ownedProcessIdentityMatches(expected.get(pid), actual))
        throw new Error(`Process ${pid} creation time disagrees with its snapshot`)
      return actual
    }
    if (pinned) {
      // Native snapshots establish ancestry before Quit. macOS pins stable
      // one-second creation times; subsequent reparenting does not mean reuse.
      return actual.startedAt === pinned.startedAt ? actual : null
    }
    if (!ownedProcessIdentityMatches(expected.get(pid), actual)) return null
    if (visited.has(pid)) throw new Error('Current process ownership contains a cycle')
    visited.add(pid)
    if (pid === applicationPid) {
      if (child && (child.exitCode === undefined || child.signalCode === undefined)) {
        throw new Error('The native application lifetime is unavailable for its first identity pin')
      }
      if (child && (child.exitCode !== null || child.signalCode !== null)) return null
      if (actual.parentPid !== expected.get(pid).parentPid) {
        throw new Error('The application changed ownership before its first identity pin')
      }
    } else {
      const parentPid = expected.get(pid).parentPid
      if (actual.parentPid !== parentPid || !readOwned(parentPid, visited)) {
        throw new Error(`Process ${pid} is not in the current application ownership chain`)
      }
    }
    instances.set(pid, actual)
    return actual
  }
  return {
    isAlive: pid => readOwned(pid) !== null,
    groupIsAlive: groupId => {
      const errors = []
      for (const { pid } of targets) {
        try {
          if (readOwned(pid)?.processGroupId === groupId) return true
        } catch (error) {
          errors.push(error)
        }
      }
      throwShutdownErrors(errors)
      if (processGroupIsAlive(groupId)) {
        throw new Error(`Application group ${groupId} contains unverified live members`)
      }
      return false
    },
  }
}

async function waitForWindowsOwnedProcessExit(targets, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const instances = new Map()
  for (;;) {
    const survivors = []
    for (const target of targets) {
      if (!processIsAlive(target.pid)) continue
      const identity = await collectWindowsProcessIdentity(target.pid)
      if (!identity) continue
      const actual = { pid: identity.Id, startedAt: Date.parse(identity.StartedAt), precisionMs: 1 }
      if (!ownedProcessIdentityMatches(target, actual)) continue
      const pinned = instances.get(target.pid)
      if (pinned && pinned !== identity.StartedAt) continue
      instances.set(target.pid, identity.StartedAt)
      survivors.push(target.pid)
    }
    if (survivors.length === 0) return
    if (Date.now() >= deadline)
      throw new Error(`Owned application processes survived shutdown: ${survivors.join(', ')}`)
    await new Promise(accept => setTimeout(accept, PROCESS_GROUP_POLL_INTERVAL_MS))
  }
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

async function waitForProcessGroupExit(processGroupId, timeoutMs, isOwnedGroup = () => true) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!isOwnedGroup() || !processGroupIsAlive(processGroupId)) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, PROCESS_GROUP_POLL_INTERVAL_MS))
  }
  return !isOwnedGroup() || !processGroupIsAlive(processGroupId)
}

export async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  logDesktopE2eSignal({ action: 'stop-process', pid: child.pid, signal: 'SIGTERM' })
  child.kill('SIGTERM')
  try {
    await waitForProcessExit(child, PROCESS_STOP_TIMEOUT_MS)
  } catch {
    logDesktopE2eSignal({ action: 'stop-process', pid: child.pid, signal: 'SIGKILL' })
    child.kill('SIGKILL')
    await waitForProcessExit(child, PROCESS_STOP_TIMEOUT_MS)
  }
}

export async function stopProcessGroup(child, { isOwnedGroup = () => true } = {}) {
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
  const signal = name => {
    if (!isOwnedGroup()) return
    signalProcessGroup(processGroupId, name)
  }
  if (!isOwnedGroup()) return
  signal('SIGTERM')
  if (child.exitCode === null && child.signalCode === null) {
    try {
      await waitForProcessExit(child, PROCESS_STOP_TIMEOUT_MS)
    } catch {
      try {
        signal('SIGKILL')
      } catch (error) {
        if (error?.code !== 'EPERM') throw error
        // macOS can reject a group signal while its leader's exit event is pending.
        await waitForProcessExit(child, PROCESS_STOP_TIMEOUT_MS, {
          requireExitEvent: true,
        }).catch(() => {
          throw error
        })
      }
      await waitForProcessExit(child, PROCESS_STOP_TIMEOUT_MS)
    }
  }
  if (await waitForProcessGroupExit(processGroupId, PROCESS_GROUP_GRACE_PERIOD_MS, isOwnedGroup))
    return
  signal('SIGKILL')
  if (!(await waitForProcessGroupExit(processGroupId, PROCESS_STOP_TIMEOUT_MS, isOwnedGroup))) {
    throw new Error(`Timed out waiting for process group ${processGroupId} to exit`)
  }
}

export function windowsTaskkillArguments(processId) {
  return ['/PID', String(processId), '/T', '/F']
}

/** A failed activation's recovery shell may never connect to the control channel. */
export async function stopRecoveryProcess(
  processId,
  {
    platform = process.platform,
    execute = execFileAsync,
    isAlive = processIsAlive,
    signal = process.kill,
  } = {}
) {
  if (!Number.isSafeInteger(processId) || processId <= 0)
    throw new Error('Recovery cleanup requires its recorded process ID')
  if (!isAlive(processId)) return
  if (platform === 'win32') {
    await execute('taskkill', windowsTaskkillArguments(processId), {
      windowsHide: true,
      timeout: PROCESS_STOP_TIMEOUT_MS,
    })
  } else signal(processId, 'SIGTERM')
  const deadline = Date.now() + PROCESS_STOP_TIMEOUT_MS
  while (isAlive(processId)) {
    if (Date.now() >= deadline) throw new Error(`Recovery process ${processId} survived cleanup`)
    await new Promise(accept => setTimeout(accept, PROCESS_GROUP_POLL_INTERVAL_MS))
  }
}

export class InvalidOwnedProcessSnapshotError extends Error {}

function ownedCrashTargets(child, snapshot) {
  return ownedProcessIdentities(child, snapshot).map(target => target.pid)
}

function ownedProcessIdentities(child, snapshot) {
  if (
    !Number.isSafeInteger(child?.pid) ||
    snapshot?.applicationPid !== child.pid ||
    snapshot.platform !== process.platform ||
    !Number.isFinite(snapshot.capturedAt) ||
    snapshot.capturedAt > Date.now() ||
    Date.now() - snapshot.capturedAt > PROCESS_STOP_TIMEOUT_MS ||
    !Array.isArray(snapshot.degraded) ||
    snapshot.degraded.length > 0 ||
    !Array.isArray(snapshot.processes)
  ) {
    throw new InvalidOwnedProcessSnapshotError(
      'An application crash requires its complete owned process snapshot'
    )
  }
  const parents = new Map()
  for (const record of snapshot.processes) {
    if (
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      parents.has(record.pid) ||
      !Number.isFinite(record.startedAt) ||
      record.startedAt <= 0 ||
      record.startedAt > Date.now() ||
      (record.instanceToken !== undefined &&
        (typeof record.instanceToken !== 'string' || !record.instanceToken.trim())) ||
      (record.exited !== undefined && typeof record.exited !== 'boolean')
    ) {
      throw new InvalidOwnedProcessSnapshotError(
        'The owned crash snapshot requires unique process identities and creation times'
      )
    }
    parents.set(record.pid, record.parentPid)
  }
  if (!parents.has(child.pid))
    throw new InvalidOwnedProcessSnapshotError('The crash snapshot is missing its application')
  for (const pid of parents.keys()) {
    const visited = new Set()
    let current = pid
    while (current !== child.pid) {
      if (!parents.has(current) || visited.has(current)) {
        throw new InvalidOwnedProcessSnapshotError(
          `Crash target ${pid} is outside the isolated application tree`
        )
      }
      visited.add(current)
      current = parents.get(current)
    }
  }
  const identities = new Map(snapshot.processes.map(record => [record.pid, { ...record }]))
  return [
    identities.get(child.pid),
    ...snapshot.processes
      .filter(record => record.pid !== child.pid)
      .map(record => identities.get(record.pid)),
  ]
}

export function validateOwnedProcessSnapshot(child, snapshot) {
  ownedProcessIdentities(child, snapshot)
}

export async function crashOwnedProcessTree(child, snapshot) {
  const targets = ownedCrashTargets(child, snapshot)
  if (process.platform === 'win32') {
    await stopWindowsProcessTree(child)
  } else {
    const frozen = []
    try {
      // Freeze every owned process before closing any pipe can settle native turns.
      for (const pid of targets) {
        try {
          process.kill(pid, 'SIGSTOP')
          frozen.push(pid)
        } catch (error) {
          if (error?.code !== 'ESRCH') throw error
        }
      }
      logDesktopE2eSignal({ action: 'crash-freeze', signal: 'SIGSTOP', pids: frozen })
      for (const pid of frozen.toReversed()) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          if (error?.code !== 'ESRCH') throw error
        }
      }
      logDesktopE2eSignal({ action: 'crash-kill', signal: 'SIGKILL', pids: frozen })
    } catch (error) {
      // Leave a diagnosable live application if the crash injection is rejected.
      logDesktopE2eSignal({ action: 'crash-resume', signal: 'SIGCONT', pids: frozen })
      for (const pid of frozen) {
        try {
          process.kill(pid, 'SIGCONT')
        } catch (resumeError) {
          if (resumeError?.code !== 'ESRCH') throw resumeError
        }
      }
      throw error
    }
  }
  const startedAt = Date.now()
  while (targets.some(processIsAlive)) {
    if (Date.now() - startedAt >= PROCESS_STOP_TIMEOUT_MS) {
      throw new Error('The isolated application process tree survived its injected crash')
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, PROCESS_GROUP_POLL_INTERVAL_MS))
  }
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

export function processGroupIsExitingFromDarwinRows(members, ownerUid) {
  return (
    Number.isInteger(ownerUid) &&
    Array.isArray(members) &&
    members.every(
      fields =>
        fields.length === 5 &&
        Number(fields[3]) === ownerUid &&
        (fields[4].startsWith('Z') || fields[4].includes('E'))
    )
  )
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal)
    logDesktopE2eSignal({
      action: 'signal-group',
      processGroupId,
      signal,
      result: 'delivered',
    })
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      let members
      if (process.platform === 'darwin') {
        try {
          members = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,uid=,stat='], {
            encoding: 'utf8',
            timeout: 1000,
            maxBuffer: 1024 * 1024,
          })
            .split('\n')
            .map(line => line.trim().split(/\s+/))
            .filter(fields => Number(fields[2]) === processGroupId)
        } catch (diagnosticError) {
          members = { error: diagnosticError.code }
        }
      }
      const exiting =
        error?.code === 'EPERM' &&
        process.platform === 'darwin' &&
        processGroupIsExitingFromDarwinRows(members, process.getuid?.())
      logDesktopE2eSignal({
        action: 'signal-group',
        processGroupId,
        signal,
        result: exiting ? 'exiting' : 'rejected',
        code: error?.code,
        callerPid: process.pid,
        callerUid: process.getuid?.(),
        members,
      })
      // Zombies and P_WEXIT members cannot receive another signal. Keep the existing exit
      // waits and deadlines; a live or unowned group still fails below.
      if (exiting) return
      throw error
    }
    logDesktopE2eSignal({ action: 'signal-group', processGroupId, signal, result: 'absent' })
  }
}
