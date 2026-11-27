import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function linuxIdentity(pid) {
  let stat
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        process.kill(pid, 0)
      } catch (probeError) {
        if (probeError.code === 'ESRCH') return null
      }
    }
    throw error
  }
  const end = stat.lastIndexOf(')')
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/)
  if (
    end < 0 ||
    !/^\d+$/.test(fields[19] ?? '') ||
    !Number.isSafeInteger(Number(fields[1])) ||
    Number(fields[1]) < 0 ||
    !Number.isSafeInteger(Number(fields[2])) ||
    Number(fields[2]) <= 0
  ) {
    throw new Error(`Process ${pid} has no readable kernel start identity`)
  }
  if (['Z', 'X', 'x'].includes(fields[0])) return null
  return {
    instanceToken: fields[19],
    parentPid: Number(fields[1]),
    processGroupId: Number(fields[2]),
  }
}

/** Fresh native identity; null means an observed exit, never a query failure. */
export function readNativeProcessIdentity(
  pid,
  { platform = process.platform, readLinux = linuxIdentity, execute = execFileSync } = {}
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Identity requires a positive PID')
  try {
    const before = platform === 'linux' ? readLinux(pid) : null
    if (platform === 'linux' && before === null) return null
    if (platform !== 'linux' && platform !== 'darwin') {
      throw new Error(`Native process identity is unavailable on ${platform}`)
    }
    // Unlike systeminformation's Unix `etime` estimate, lstart is stable.
    // Its one-second resolution is explicit; Linux also pins kernel start ticks.
    const output = execute('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,stat=,lstart='], {
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 4096,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    }).trim()
    const row = output.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    const startedAt = row ? Date.parse(row[5]) : NaN
    if (!row || Number(row[1]) !== pid || !Number.isFinite(startedAt)) {
      throw new Error(`Process ${pid} has no readable creation time`)
    }
    const after = platform === 'linux' ? readLinux(pid) : null
    if (platform === 'linux' && after === null) return null
    if (before && before.instanceToken !== after.instanceToken) {
      throw new Error(`Process ${pid} changed identity during collection`)
    }
    if (['Z', 'X', 'x'].includes(row[4][0])) {
      if (platform === 'darwin') return null
      throw new Error(`Process ${pid} changed state during collection`)
    }
    return {
      pid,
      startedAt,
      precisionMs: 1000,
      parentPid: Number(row[2]),
      processGroupId: Number(row[3]),
      ...(after ?? {}),
    }
  } catch (error) {
    // ps exits with status 1 for an absent macOS PID. Confirm exit separately.
    // Permission errors, malformed output, and timeouts must remain failures.
    try {
      process.kill(pid, 0)
    } catch (probeError) {
      if (probeError.code === 'ESRCH') return null
    }
    throw new Error(`Could not verify process ${pid} identity`, { cause: error })
  }
}

export function ownedProcessIdentityMatches(expected, actual) {
  if (actual === null) return false
  if (
    !Number.isFinite(actual?.startedAt) ||
    actual.startedAt <= 0 ||
    ![1, 1000].includes(actual.precisionMs)
  ) {
    throw new Error(`Process ${expected.pid} has an unknown creation time`)
  }
  if (actual.pid !== expected.pid) return false
  if (expected.source === 'system' || expected.source === 'host') {
    // The owning explorer reconstructs Unix starts from integer `etime`.
    // Allow only its documented one-second estimation error on the first read.
    return Math.abs(expected.startedAt - actual.startedAt) <= actual.precisionMs
  }
  if (expected.source === 'electron') {
    return (
      expected.startedAt >= actual.startedAt &&
      expected.startedAt < actual.startedAt + actual.precisionMs
    )
  }
  return expected.startedAt === actual.startedAt
}

/** Enumerate the complete isolated application tree without any renderer action. */
export function captureOwnedProcessSnapshot(
  applicationIdentity,
  { platform = process.platform, execute = execFileSync, readLinux = linuxIdentity } = {}
) {
  const capturedAt = Date.now()
  const output = execute('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  })
  const records = new Map()
  const children = new Map()
  for (const line of output.split(/\r?\n/).filter(line => line.trim())) {
    const row = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    const startedAt = row ? Date.parse(row[5]) : NaN
    if (!row || !Number.isFinite(startedAt))
      throw new Error('Native process enumeration is incomplete')
    const record = {
      pid: Number(row[1]),
      parentPid: Number(row[2]),
      processGroupId: Number(row[3]),
      startedAt,
    }
    if (['Z', 'X', 'x'].includes(row[4][0])) record.exited = true
    if (records.has(record.pid))
      throw new Error('Native process enumeration contains duplicate identities')
    records.set(record.pid, record)
    const descendants = children.get(record.parentPid) ?? []
    descendants.push(record.pid)
    children.set(record.parentPid, descendants)
  }
  const processes = []
  const pending = [applicationIdentity.pid]
  for (let index = 0; index < pending.length; index++) {
    const pid = pending[index]
    const record = records.get(pid)
    if (!record) throw new Error('Native process enumeration omitted the application')
    if (platform === 'linux' && !record.exited) {
      const current = readLinux(pid)
      if (current === null) record.exited = true
      else {
        if (
          current.parentPid !== record.parentPid ||
          current.processGroupId !== record.processGroupId
        ) {
          throw new Error(`Process ${pid} changed ownership during enumeration`)
        }
        record.instanceToken = current.instanceToken
      }
    }
    processes.push(record)
    pending.push(...(children.get(pid) ?? []))
    if (pending.length > records.size)
      throw new Error('Native process enumeration contains an ownership cycle')
  }
  const root = processes[0]
  if (
    root.exited ||
    (applicationIdentity.instanceToken
      ? root.instanceToken !== applicationIdentity.instanceToken
      : root.startedAt !== applicationIdentity.startedAt)
  ) {
    throw new Error('The isolated application changed identity before shutdown')
  }
  return { applicationPid: applicationIdentity.pid, platform, capturedAt, degraded: [], processes }
}
