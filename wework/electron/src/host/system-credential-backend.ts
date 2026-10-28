import { HostCapabilityError } from './capability-router.js'

export interface CredentialBackend {
  get(account: string): Promise<string | null>
  set(account: string, value: string): Promise<void>
  delete(account: string): Promise<void>
}

/** Native APIs run inside the signed Host, never through a command-line helper. */
export class SystemCredentialBackend implements CredentialBackend {
  private failed = false

  constructor(private readonly service: string) {}

  get(account: string): Promise<string | null> {
    return this.run(account, async entry => {
      const bytes = await entry.getSecret()
      return bytes === null
        ? null
        : new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes))
    })
  }

  set(account: string, value: string): Promise<void> {
    return this.run(account, entry => entry.setSecret(Buffer.from(value, 'utf8')))
  }

  delete(account: string): Promise<void> {
    return this.run(account, async entry => {
      await entry.deleteCredential()
    })
  }

  private async run<T>(
    account: string,
    operation: (entry: import('@napi-rs/keyring').AsyncEntry) => Promise<T>
  ): Promise<T> {
    if (this.failed) throw unavailable()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const { AsyncEntry } = await import('@napi-rs/keyring')
      const entry = new AsyncEntry(this.service, account, { linux: { store: 'secret-service' } })
      return await Promise.race([
        operation(entry),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            // An ambiguous native write blocks later operations until process restart.
            this.failed = true
            reject(unavailable())
          }, 30_000)
        }),
      ])
    } catch {
      // Native errors can contain attributes or secrets. Export only a stable code.
      throw unavailable()
    } finally {
      clearTimeout(timer)
    }
  }
}

function unavailable(): HostCapabilityError {
  return new HostCapabilityError(
    'secure_storage_unavailable',
    'System credential storage is unavailable; unlock it or restart the application'
  )
}
