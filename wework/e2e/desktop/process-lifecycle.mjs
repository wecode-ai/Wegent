const PROCESS_STOP_TIMEOUT_MS = 10_000

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

  signalProcessGroup(child.pid, 'SIGTERM')
  if (child.exitCode === null && child.signalCode === null) {
    try {
      await waitForProcessExit(child, PROCESS_STOP_TIMEOUT_MS)
    } catch {
      signalProcessGroup(child.pid, 'SIGKILL')
      await waitForProcessExit(child, PROCESS_STOP_TIMEOUT_MS)
      return
    }
  }
  signalProcessGroup(child.pid, 'SIGKILL')
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}
