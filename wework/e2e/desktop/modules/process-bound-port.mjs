import { readFile } from 'node:fs/promises'

export async function waitForProcessBoundPort(child, logPath, { fromOffset = 0, timeoutMs }) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Backend exited before binding a port; see ${logPath}`)
    }
    const output = await readFile(logPath, 'utf8').catch(() => '')
    const match = /Uvicorn running on http:\/\/127\.0\.0\.1:(\d+)\b/.exec(output.slice(fromOffset))
    if (match) {
      const port = Number(match[1])
      if (port > 0 && port <= 65535) return port
      throw new Error(`Backend advertised an invalid port; see ${logPath}`)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Backend did not bind a port; see ${logPath}`)
}
