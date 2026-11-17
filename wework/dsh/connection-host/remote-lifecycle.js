import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'

/** The existing native lock follows the service pipe, including abrupt parent death. */
export async function acquireRemoteConnectionLock(executor, lockPath) {
  if (!isAbsolute(executor ?? '') || !isAbsolute(lockPath))
    throw new Error('Connection service requires its delivered native lock executable')
  const child = spawn(executor, ['--workbench-lock', JSON.stringify([lockPath])], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  // Keep diagnostics bounded; paths and inherited environment never enter plugin output.
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  try {
    await new Promise((resolve, reject) => {
      const failed = () => reject(new Error('Connection service owner lock is unavailable'))
      const timer = setTimeout(failed, 30_000)
      const cleanup = () => {
        clearTimeout(timer)
        child.off('error', failed)
        child.off('exit', failed)
      }
      child.once('error', failed)
      child.once('exit', failed)
      lines.once('line', line => {
        cleanup()
        if (line.length > 128) return failed()
        try {
          const ack = JSON.parse(line)
          if (ack.protocol_version !== 1 || ack.locked !== true) return failed()
          resolve()
        } catch {
          failed()
        }
      })
      child.once('close', cleanup)
    })
  } catch (error) {
    child.stdin.destroy()
    child.kill()
    throw error
  } finally {
    lines.close()
  }
  // Do not close this pipe from a process exit hook: plugin exit hooks may still write state.
  // The OS closes it after the service exits, releasing the lock only after its last writer.
  child.once('exit', () => {
    console.error('Connection service owner lock closed unexpectedly')
    process.exit(1)
  })
}

export function watchRemoteConnectionParent() {
  // Runtime owns this pipe. A crash and a normal stop both close it without PID guessing.
  process.stdin.once('end', () => process.exit(0))
  process.stdin.once('error', () => process.exit(1))
  process.stdin.resume()
}
