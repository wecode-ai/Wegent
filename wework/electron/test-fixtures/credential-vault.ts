import type { CredentialBackend } from '../src/host/system-credential-backend.js'
import type { WorkbenchMigrationLockAdapter } from '../src/runtime/workbench-migration-lock.js'

/** An explicit test adapter, never selected by production platform detection. */
export class MemoryCredentialBackend implements CredentialBackend {
  readonly values = new Map<string, string>()
  readonly trace: string[] = []
  fault: ((stage: string, operation: number) => void) | null = null
  private operations = 0

  private async run<T>(stage: string, work: () => T): Promise<T> {
    const index = ++this.operations
    this.trace.push(stage)
    this.fault?.(`before:${stage}`, index)
    const result = work()
    this.fault?.(`after:${stage}`, index)
    return result
  }
  get(account: string): Promise<string | null> {
    return this.run(`get:${account}`, () => this.values.get(account) ?? null)
  }
  set(account: string, value: string): Promise<void> {
    return this.run(`set:${account}`, () => {
      this.values.set(account, value)
    })
  }
  delete(account: string): Promise<void> {
    return this.run(`delete:${account}`, () => {
      this.values.delete(account)
    })
  }
}

export function testCredentialLock(): WorkbenchMigrationLockAdapter {
  let pending = Promise.resolve()
  return async () => {
    const before = pending
    let release!: () => void
    pending = new Promise<void>(resolve => {
      release = resolve
    })
    await before
    return {
      assertHeld() {},
      async release() {
        release()
      },
    }
  }
}
