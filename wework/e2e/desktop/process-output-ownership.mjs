import { collectWindowsProcessIdentity } from './process-lifecycle.mjs'

// Keep identities only; labels, command lines and environment can contain secrets.
export async function captureOutputOwnership(control) {
  const snapshot = JSON.parse(await control.command('getOwnedProcessSnapshot', 'body'))
  return {
    capturedAt: snapshot.capturedAt,
    applicationPid: snapshot.applicationPid,
    collectingSystemProcesses: snapshot.collectingSystemProcesses ?? false,
    degraded: snapshot.degraded.map(({ code }) => ({ code })),
    processes: snapshot.processes.map(({ pid, parentPid, startedAt }) => ({
      pid,
      parentPid,
      startedAt,
    })),
  }
}

export async function inspectOutputOwners(snapshot) {
  const pending = [...new Set(snapshot.processes.map(process => process.pid))]
  const results = []
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (pending.length) {
        const pid = pending.shift()
        try {
          const identity = await collectWindowsProcessIdentity(pid)
          results.push({
            pid,
            status: identity ? 'present' : 'absent',
            startedAt: identity?.StartedAt ?? null,
          })
        } catch (error) {
          results.push({ pid, status: 'query-failed', code: error.code ?? null })
        }
      }
    })
  )
  // A matching PID alone does not establish process identity or pipe ownership.
  return results.sort((a, b) => a.pid - b.pid)
}
