const PROCESS_STOP_TIMEOUT_MS = 10_000
const PROCESS_GROUP_GRACE_PERIOD_MS = 1_000
const PROCESS_GROUP_POLL_INTERVAL_MS = 25

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
    new Promise(resolvePromise => child.once('exit', resolvePromise)),
    timeoutMs,
    `Timed out waiting for process ${child.pid ?? 'unknown'} to exit`
  )
}

function isProcessGroupRunning(processGroupId) {
  try {
    process.kill(-processGroupId, 0)
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
    if (!isProcessGroupRunning(processGroupId)) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, PROCESS_GROUP_POLL_INTERVAL_MS))
  }
  return !isProcessGroupRunning(processGroupId)
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
  if (process.platform === 'win32' || !Number.isInteger(child.pid)) {
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

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}
