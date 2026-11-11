import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WorkbenchReminder } from './workbench-app-capabilities.js'
import { workbenchId } from './workbench-application-contract.js'

export interface WorkbenchAppData {
  state: unknown
  reminders: WorkbenchReminder[]
}

export function workbenchInstallationId(id: string): string {
  return workbenchId(id)
}

export function validateWorkbenchState(value: unknown): unknown {
  const serialized = JSON.stringify(value)
  if (serialized === undefined || Buffer.byteLength(serialized) > 1024 * 1024)
    throw new Error('Workbench data must be JSON of at most 1 MiB')
  return JSON.parse(serialized)
}

export function validateWorkbenchReminders(value: unknown): WorkbenchReminder[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error('A workbench supports at most 100 reminders')
  const reminders = value.map(candidate => {
    if (!candidate || typeof candidate !== 'object') throw new Error('Invalid reminder')
    const { id, title, at } = candidate
    const body = candidate.body ?? ''
    if (
      typeof id !== 'string' ||
      !id.trim() ||
      id.length > 128 ||
      typeof title !== 'string' ||
      !title.trim() ||
      title.length > 160 ||
      typeof body !== 'string' ||
      body.length > 2000 ||
      typeof at !== 'string' ||
      !Number.isFinite(Date.parse(at))
    )
      throw new Error('Invalid reminder')
    return { id: id.trim(), title: title.trim(), body, at: new Date(at).toISOString() }
  })
  if (new Set(reminders.map(item => item.id)).size !== reminders.length)
    throw new Error('Reminder ids must be unique')
  return reminders
}

/** App state belongs to the existing DSH installation, independently of its views. */
export class WorkbenchAppDataStore {
  private readonly pending = new Map<string, Promise<unknown>>()

  constructor(private readonly dataDirectory: string) {}

  path(id: string): string {
    return join(
      this.dataDirectory,
      'harness-apps',
      'instances',
      workbenchInstallationId(id),
      'wework-app.json'
    )
  }

  async read(id: string): Promise<WorkbenchAppData> {
    try {
      const value = JSON.parse(await readFile(this.path(id), 'utf8')) as WorkbenchAppData
      if (!value || !Object.hasOwn(value, 'state')) throw new Error('Invalid workbench data')
      return {
        state: validateWorkbenchState(value.state),
        reminders: validateWorkbenchReminders(value.reminders),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: null, reminders: [] }
      throw error
    }
  }

  update(id: string, apply: (data: WorkbenchAppData) => void | Promise<void>): Promise<void> {
    return this.serial(id, async () => {
      const data = await this.read(id)
      await apply(data)
      await this.write(id, data)
    })
  }

  commit(id: string, state: unknown, reminders?: unknown): Promise<void> {
    const snapshot = validateWorkbenchState(state)
    const scheduled = reminders === undefined ? undefined : validateWorkbenchReminders(reminders)
    return this.update(id, data => {
      for (const reminder of scheduled ?? []) {
        if (
          Date.parse(reminder.at) <= Date.now() &&
          !data.reminders.some(
            existing => existing.id === reminder.id && existing.at === reminder.at
          )
        )
          throw new Error('New reminder times must be in the future')
      }
      data.state = snapshot
      if (scheduled !== undefined) data.reminders = scheduled
    })
  }

  remove(id: string): Promise<void> {
    return this.serial(id, () => rm(this.path(id), { force: true }))
  }

  /** Import never overwrites newer data; the legacy source remains recoverable. */
  importLegacy(id: string, legacy: WorkbenchAppData): Promise<void> {
    const snapshot = legacySnapshot(legacy)
    return this.serial(id, async () => {
      if (!(await this.legacyCompatible(id, snapshot))) await this.write(id, snapshot)
    })
  }

  checkLegacyImport(id: string, legacy: WorkbenchAppData): Promise<void> {
    const snapshot = legacySnapshot(legacy)
    return this.serial(id, async () => {
      await this.legacyCompatible(id, snapshot)
    })
  }

  private async legacyCompatible(id: string, snapshot: WorkbenchAppData): Promise<boolean> {
    try {
      await readFile(this.path(id))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (JSON.stringify(await this.read(id)) !== JSON.stringify(snapshot))
      throw new Error(
        'Workbench data already exists; legacy data was preserved without overwriting it'
      )
    return true
  }

  private async write(id: string, data: WorkbenchAppData): Promise<void> {
    const path = this.path(id)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const pending = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(pending, JSON.stringify(data), { mode: 0o600 })
      await rename(pending, path)
    } finally {
      await rm(pending, { force: true })
    }
  }

  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    workbenchInstallationId(id)
    const result = (this.pending.get(id) ?? Promise.resolve()).then(operation)
    const settled = result.catch(() => {})
    this.pending.set(id, settled)
    void settled.then(() => {
      if (this.pending.get(id) === settled) this.pending.delete(id)
    })
    return result
  }
}

function legacySnapshot(legacy: WorkbenchAppData): WorkbenchAppData {
  return {
    state: validateWorkbenchState(legacy.state),
    reminders: validateWorkbenchReminders(legacy.reminders),
  }
}
