import type { BrowserWindow } from 'electron'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import { workbenchMethodCapability } from './workbench-app-capabilities.js'
import { WorkbenchAppDataStore } from './workbench-app-data.js'
import { invokeWorkbenchSystem } from './workbench-app-system.js'

interface Installation {
  id: string
  manifest: WorkbenchAppManifest
  grantedCapabilities?: { native?: readonly string[]; decisionModel?: boolean }
}

export interface WorkbenchAppServicesOptions {
  get(id: string): Promise<Installation>
  open(id: string): Promise<unknown>
  window(id: string): BrowserWindow | null
  hide?(id: string): Promise<void>
  setAlwaysOnTop?(id: string, value: boolean): Promise<void>
  report?(error: unknown): void
}

/** Installation-scoped data and native capabilities; no process or view ownership. */
export class WorkbenchAppServices {
  readonly data: WorkbenchAppDataStore
  private disposed = false
  private readonly revoked = new Set<string>()

  constructor(
    dataDirectory: string,
    private readonly options: WorkbenchAppServicesOptions
  ) {
    this.data = new WorkbenchAppDataStore(dataDirectory)
  }

  async invoke(id: string, method: string, input: unknown = {}): Promise<unknown> {
    if (typeof method !== 'string') throw new Error('Invalid workbench method')
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Expected method parameters')
    const params = input as Record<string, unknown>
    const installation = await this.authorize(id, method)
    switch (method) {
      case 'storage.get':
        return (await this.data.read(id)).state
      case 'storage.set':
        this.assertAvailable(id)
        await this.data.commit(id, params.value)
        return null
      case 'window.hide':
        this.assertAvailable(id)
        if (!this.options.hide) throw new Error('Workbench window controls are unavailable')
        await this.options.hide(id)
        return null
      case 'window.setAlwaysOnTop':
        this.assertAvailable(id)
        if (typeof params.value !== 'boolean') throw new Error('alwaysOnTop must be a boolean')
        if (!this.options.setAlwaysOnTop)
          throw new Error('Workbench window controls are unavailable')
        await this.options.setAlwaysOnTop(id, params.value)
        return null
      default: {
        this.assertAvailable(id)
        const window =
          method === 'files.openText' || method === 'files.saveText'
            ? this.options.window(id)
            : null
        const assertAuthorized = async () => {
          await this.authorize(id, method)
          if (window?.isDestroyed()) throw new Error('Workbench view is no longer available')
          if (window && this.options.window(id) !== window)
            throw new Error('Workbench view changed during native interaction')
        }
        return invokeWorkbenchSystem(
          method,
          params,
          window,
          installation.manifest.displayName,
          () => {
            void this.options.open(id).catch(error => this.report(error))
          },
          assertAuthorized
        )
      }
    }
  }

  async removeData(id: string): Promise<void> {
    await this.data.remove(id)
  }

  revoke(id: string): void {
    this.revoked.add(id)
  }
  activate(id: string): void {
    this.revoked.delete(id)
  }

  dispose(): void {
    this.disposed = true
  }

  private async authorize(id: string, method: string): Promise<Installation> {
    this.assertAvailable(id)
    const installation = await this.options.get(id)
    this.assertAvailable(id)
    const capability = workbenchMethodCapability(method)
    if (capability && !this.granted(installation, capability))
      throw new Error(`Workbench capability denied: ${capability}`)
    return installation
  }
  private assertAvailable(id: string): void {
    if (this.disposed || this.revoked.has(id)) throw new Error('Workbench services are stopped')
  }

  private report(error: unknown): void {
    this.options.report?.(error)
  }

  private granted(installation: Installation, capability: string): boolean {
    return Boolean(
      installation.manifest.capabilities?.native?.some(item => item === capability) &&
      installation.grantedCapabilities?.native?.includes(capability)
    )
  }
}
