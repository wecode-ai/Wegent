import { spawn } from 'node:child_process'
import { basename, dirname, join } from 'node:path'

export interface WorkbenchMigrationLock {
  assertHeld(): void
  release(): Promise<void>
}

export type WorkbenchMigrationLockAdapter = (resources: string[]) => Promise<WorkbenchMigrationLock>

export function executorMigrationLock(executorPath: string): WorkbenchMigrationLockAdapter {
  return async resources => {
    const files = [
      ...new Set(
        resources.map(path => join(dirname(path), `.wework-home-migration-${basename(path)}.lock`))
      ),
    ].sort()
    const child = spawn(
      executorPath.trim(),
      ['--workbench-lock', JSON.stringify(files), '--version'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
        },
        windowsHide: true,
      }
    )
    let closed = false
    let spawnError = false
    child.stdin.on('error', () => {
      spawnError = true
    })
    const ended = new Promise<number | null>(accept => {
      child.once('error', () => {
        spawnError = true
      })
      child.once('close', code => {
        closed = true
        accept(code)
      })
    })
    child.stderr.resume()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((accept, reject) => {
        let output = ''
        const fail = () => reject(new Error('Workbench Home migration lock unavailable'))
        timeout = setTimeout(fail, 5_000)
        child.once('error', fail)
        void ended.then(fail)
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          output += chunk
          if (output.length > 4096) return fail()
          if (!output.includes('\n')) return
          try {
            const response = JSON.parse(output.trim())
            if (response?.protocol_version !== 1 || response?.locked !== true) return fail()
            accept()
          } catch {
            fail()
          }
        })
      })
    } catch (error) {
      child.kill('SIGKILL')
      child.stdin.destroy()
      await ended
      throw error
    } finally {
      clearTimeout(timeout)
    }
    const assertHeld = () => {
      if (closed || spawnError || child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Workbench Home migration lock process exited unexpectedly')
      }
    }
    return {
      assertHeld,
      async release() {
        const wasLost = closed || spawnError || child.exitCode !== null || child.signalCode !== null
        child.stdin.end()
        const kill = setTimeout(() => child.kill('SIGKILL'), 5_000)
        try {
          const code = await ended
          if (wasLost || code !== 0) throw new Error('Workbench Home migration lock release failed')
        } finally {
          clearTimeout(kill)
        }
      },
    }
  }
}
