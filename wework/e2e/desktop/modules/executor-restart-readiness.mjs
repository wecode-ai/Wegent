import { readFile } from 'node:fs/promises'

export async function currentExecutorPid(control) {
  const diagnostics = JSON.parse(await control.command('getDesktopRuntimeDiagnostics', 'body'))
  const pid = Number(diagnostics.executorPid)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function hasRestartedProtocol(logContent, pid) {
  const spawn = [
    ...logContent.matchAll(new RegExp(`\\[supervisor\\] spawned pid=${pid}\\b`, 'g')),
  ].at(-1)
  if (!spawn) return false
  const processLog = logContent
    .slice(spawn.index + spawn[0].length)
    .split(/\[supervisor\] (?:exited|spawned)\b/)[0]
  return /app IPC request started request_id=(\S+) method=executor\.protocol\.describe[\s\S]*?app IPC request finished request_id=\1 method=executor\.protocol\.describe[^\n]*ok=true/.test(
    processLog
  )
}

async function bridgeIsReady(origin, timeoutMs) {
  try {
    // This endpoint succeeds only after the bridge caches its negotiated method list.
    const response = await fetch(`${origin}/wework/executor/v1`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch (error) {
    if (error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error.name))
      return false
    throw error
  }
}

export async function waitForRestartedExecutor({
  control,
  originalPid,
  executorLogPath,
  logOffset,
  timeoutMs,
}) {
  const startedAt = Date.now()
  const origin = await control.command('getLocationOrigin', 'body')
  while (Date.now() - startedAt < timeoutMs) {
    const pid = await currentExecutorPid(control)
    const logContent = (await readFile(executorLogPath, 'utf8')).slice(logOffset)
    if (
      pid &&
      pid !== originalPid &&
      hasRestartedProtocol(logContent, pid) &&
      (await bridgeIsReady(origin, Math.max(1, timeoutMs - (Date.now() - startedAt))))
    ) {
      return pid
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The restarted executor did not become protocol-ready through the DSH bridge')
}
