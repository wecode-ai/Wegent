import { spawn, type ChildProcess } from 'node:child_process'

export interface ProcessExplorerFixture {
  /** Starts a child of the application and resolves once the OS has admitted it. */
  spawn(): Promise<{ pid: number }>
  /** Stops the child and resolves once it has left the process table. */
  stop(): Promise<{ stopped: boolean }>
}

/**
 * Test-only child process for the process explorer E2E. The explorer lists
 * every descendant of the application, so a plain child of the main process
 * appears like any other process an executor forked. It holds no resources.
 */
export function createProcessExplorerFixture(): ProcessExplorerFixture {
  let child: ChildProcess | null = null
  let exited: Promise<void> = Promise.resolve()
  return {
    spawn() {
      if (child) return Promise.reject(new Error('A process explorer fixture is already running'))
      return new Promise((resolve, reject) => {
        const started = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: 'ignore',
        })
        exited = new Promise<void>(settle => started.once('exit', settle))
        child = started
        started.once('spawn', () => resolve({ pid: started.pid as number }))
        started.once('error', error => {
          if (child === started) child = null
          reject(error)
        })
        started.once('exit', () => {
          if (child === started) child = null
        })
      })
    },
    async stop() {
      const target = child
      if (!target) return { stopped: false }
      target.kill()
      await exited
      return { stopped: true }
    },
  }
}
