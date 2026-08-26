import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const DEVICE_ID_FILE = 'desktop-device-id'

interface WorktreeRecord {
  deviceId?: unknown
  updatedAt?: unknown
}

interface WorktreeState {
  records?: Record<string, WorktreeRecord>
}

export async function resolveDesktopDeviceId(options: {
  dataDirectory: string
  executorHome: string
  environment: NodeJS.ProcessEnv
}): Promise<string> {
  const configured = options.environment.WEGENT_APP_IPC_DEVICE_ID?.trim()
  if (configured) return configured

  const path = join(options.dataDirectory, DEVICE_ID_FILE)
  const persisted = await readDeviceId(path)
  if (persisted) return persisted

  const deviceId =
    (await inferExistingElectronDeviceId(options.executorHome)) ?? `electron-${randomUUID()}`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const file = await open(path, 'wx', 0o600)
    try {
      await file.writeFile(`${deviceId}\n`)
    } finally {
      await file.close()
    }
    return deviceId
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const winningDeviceId = await readDeviceId(path)
    if (!winningDeviceId) {
      throw new Error(`Desktop device identity is empty: ${path}`, { cause: error })
    }
    return winningDeviceId
  }
}

async function readDeviceId(path: string): Promise<string | null> {
  try {
    const deviceId = (await readFile(path, 'utf8')).trim()
    if (!deviceId) throw new Error(`Desktop device identity is empty: ${path}`)
    return deviceId
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function inferExistingElectronDeviceId(executorHome: string): Promise<string | null> {
  const path = join(executorHome, 'runtime-work', 'worktrees.json')
  let state: WorktreeState
  try {
    state = JSON.parse(await readFile(path, 'utf8')) as WorktreeState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  const candidates = new Map<string, { count: number; latestUpdatedAt: number }>()
  for (const record of Object.values(state.records ?? {})) {
    if (typeof record.deviceId !== 'string' || !record.deviceId.startsWith('electron-')) continue
    const candidate = candidates.get(record.deviceId) ?? {
      count: 0,
      latestUpdatedAt: 0,
    }
    candidate.count += 1
    if (typeof record.updatedAt === 'number') {
      candidate.latestUpdatedAt = Math.max(candidate.latestUpdatedAt, record.updatedAt)
    }
    candidates.set(record.deviceId, candidate)
  }

  return (
    [...candidates.entries()].sort(
      ([leftId, left], [rightId, right]) =>
        right.count - left.count ||
        right.latestUpdatedAt - left.latestUpdatedAt ||
        leftId.localeCompare(rightId)
    )[0]?.[0] ?? null
  )
}
