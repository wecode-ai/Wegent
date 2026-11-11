import type { BrowserWindow } from 'electron'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import { workbenchMethodCapability, type WorkbenchReminder } from './workbench-app-capabilities.js'
import { WorkbenchAppDataStore, validateWorkbenchReminders } from './workbench-app-data.js'
import { invokeWorkbenchSystem, showWorkbenchNotification } from './workbench-app-system.js'

interface Installation {
  id: string
  manifest: WorkbenchAppManifest
  grantedCapabilities?: { native?: readonly string[]; decisionModel?: boolean }
}

export interface WorkbenchAppServicesOptions {
  list(): Promise<Installation[]>
  get(id: string): Promise<Installation>
  open(id: string): Promise<unknown>
  window(id: string): BrowserWindow | null
  hide?(id: string): Promise<void>
  setAlwaysOnTop?(id: string, value: boolean): Promise<void>
  report?(error: unknown): void
}

/** Scoped capabilities and durable alarms; no registry, process or view ownership. */
export class WorkbenchAppServices {
  readonly data: WorkbenchAppDataStore
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly generations = new Map<string, object>()
  private readonly refreshRevisions = new Map<string, object>()
  private disposed = false
  private readonly revoked = new Set<string>()

  constructor(
    dataDirectory: string,
    private readonly options: WorkbenchAppServicesOptions
  ) {
    this.data = new WorkbenchAppDataStore(dataDirectory)
  }

  async start(): Promise<void> {
    for (const installation of await this.options.list()) {
      try {
        await this.refresh(installation.id)
      } catch (error) {
        this.report(error)
      }
    }
  }

  async invoke(id: string, method: string, input: unknown = {}): Promise<unknown> {
    if (typeof method !== 'string') throw new Error('Invalid workbench method')
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Expected method parameters')
    const params = input as Record<string, unknown>
    const installation = await this.authorize(id, method, params)
    switch (method) {
      case 'storage.get':
        return (await this.data.read(id)).state
      case 'storage.set':
      case 'storage.commit': {
        this.assertAvailable(id)
        const reminders =
          method === 'storage.commit' && Object.hasOwn(params, 'reminders')
            ? params.reminders
            : undefined
        if (
          method === 'storage.commit' &&
          Object.hasOwn(params, 'reminders') &&
          !Array.isArray(reminders)
        )
          throw new Error('Reminders must be an array')
        await this.data.commit(id, params.value, reminders)
        await this.refresh(id)
        return null
      }
      case 'reminders.list':
        return (await this.data.read(id)).reminders
      case 'reminders.schedule': {
        this.assertAvailable(id)
        const [reminder] = validateWorkbenchReminders([params])
        if (Date.parse(reminder!.at) <= Date.now())
          throw new Error('New reminder times must be in the future')
        await this.data.update(id, data => {
          data.reminders = data.reminders.filter(item => item.id !== reminder!.id)
          if (data.reminders.length >= 100)
            throw new Error('A workbench supports at most 100 reminders')
          data.reminders.push(reminder!)
        })
        await this.refresh(id)
        return reminder
      }
      case 'reminders.cancel':
        this.assertAvailable(id)
        if (typeof params.id !== 'string' || !params.id.trim())
          throw new Error('Invalid reminder id')
        await this.data.update(id, data => {
          data.reminders = data.reminders.filter(item => item.id !== params.id)
        })
        await this.refresh(id)
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
          await this.authorize(id, method, params)
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

  async refresh(id: string): Promise<void> {
    const revision = this.clear(id)
    if (!this.isCurrentRefresh(id, revision)) return
    const installation = await this.options.get(id)
    if (!this.isCurrentRefresh(id, revision)) return
    if (!this.granted(installation, 'notifications')) return
    const reminders = (await this.data.read(id)).reminders
    if (!this.isCurrentRefresh(id, revision)) return
    for (const reminder of reminders) this.arm(id, reminder)
  }

  async removeData(id: string): Promise<void> {
    this.clear(id)
    await this.data.remove(id)
  }

  revoke(id: string): void {
    this.revoked.add(id)
    this.clear(id)
  }
  activate(id: string): void {
    this.revoked.delete(id)
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.generations.clear()
    this.refreshRevisions.clear()
  }

  private async authorize(
    id: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<Installation> {
    this.assertAvailable(id)
    const installation = await this.options.get(id)
    this.assertAvailable(id)
    const capability =
      method === 'storage.commit' && Object.hasOwn(params, 'reminders')
        ? 'notifications'
        : workbenchMethodCapability(method)
    if (capability && !this.granted(installation, capability))
      throw new Error(`Workbench capability denied: ${capability}`)
    return installation
  }
  private assertAvailable(id: string): void {
    if (this.disposed || this.revoked.has(id)) throw new Error('Workbench services are stopped')
  }

  private arm(id: string, reminder: WorkbenchReminder): void {
    const key = JSON.stringify([id, reminder.id])
    const generation = {}
    this.generations.set(key, generation)
    const timer = setTimeout(
      () => {
        this.timers.delete(key)
        void this.deliver(id, reminder, key, generation).catch(error => this.report(error))
      },
      Math.max(0, Math.min(Date.parse(reminder.at) - Date.now(), 2_147_483_647))
    )
    timer.unref?.()
    this.timers.set(key, timer)
  }

  private async deliver(
    id: string,
    reminder: WorkbenchReminder,
    key: string,
    generation: object
  ): Promise<void> {
    const installation = await this.options.get(id)
    const persisted = (await this.data.read(id)).reminders.find(
      item => item.id === reminder.id && item.at === reminder.at
    )
    if (
      this.disposed ||
      this.generations.get(key) !== generation ||
      !persisted ||
      !this.granted(installation, 'notifications')
    )
      return
    if (Date.parse(reminder.at) > Date.now()) {
      this.arm(id, reminder)
      return
    }
    showWorkbenchNotification(installation.manifest.displayName, { ...reminder }, () => {
      void this.options.open(id).catch(error => this.report(error))
    })
    await this.data.update(id, data => {
      data.reminders = data.reminders.filter(
        item => item.id !== reminder.id || item.at !== reminder.at
      )
    })
    if (this.generations.get(key) === generation) this.generations.delete(key)
  }

  private isCurrentRefresh(id: string, revision: object): boolean {
    return !this.disposed && !this.revoked.has(id) && this.refreshRevisions.get(id) === revision
  }

  private clear(id: string): object {
    const revision = {}
    this.refreshRevisions.set(id, revision)
    for (const key of this.generations.keys()) {
      if (JSON.parse(key)[0] !== id) continue
      const timer = this.timers.get(key)
      if (timer) clearTimeout(timer)
      this.timers.delete(key)
      this.generations.delete(key)
    }
    return revision
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
