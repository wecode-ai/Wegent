import { createHash } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'

const MANIFEST_PATH = '.wework-plugin/plugin.json'
const MAX_RESPONSE_BYTES = 1024 * 1024

interface WorkbenchFrontendModule {
  entry: string
  export?: string | null
  sha256: string
}

interface WorkbenchDesktopSidecar {
  command: string
  args: string[]
  sha256: string
  capabilities: string[]
}

export interface WorkbenchPluginManifest {
  name: string
  version?: string | null
  apiVersion: '1'
  required: boolean
  pinnedToClientVersion: boolean
  clientVersion?: string | null
  frontend?: WorkbenchFrontendModule | null
  desktop?: WorkbenchDesktopSidecar | null
}

export interface InspectedWorkbenchPlugin {
  root: string
  manifest: WorkbenchPluginManifest
  frontendPath?: string | null
  desktopPath?: string | null
}

interface RunningSidecar {
  child: PluginChild
  lines: AsyncIterator<string>
  readline: ReadlineInterface
  nextRequestId: number
  capabilities: ReadonlySet<string>
  requestTail: Promise<void>
}

type PluginChild = ChildProcessByStdio<Writable, Readable, null>

export class WorkbenchPluginManager {
  private readonly sidecars = new Map<string, RunningSidecar>()

  constructor(private readonly searchRoots = defaultPluginSearchRoots()) {}

  async list(): Promise<InspectedWorkbenchPlugin[]> {
    const roots: string[] = []
    for (const searchRoot of this.searchRoots) {
      await collectPluginRoots(searchRoot, 6, roots)
    }
    const uniqueRoots = [...new Set(roots)].sort()
    const inspected = await Promise.all(
      uniqueRoots.map(root => this.inspect(root).catch(() => null))
    )
    return inspected.filter((plugin): plugin is InspectedWorkbenchPlugin => plugin !== null)
  }

  async inspect(rawRoot: string): Promise<InspectedWorkbenchPlugin> {
    const root = await canonicalPluginRoot(rawRoot)
    const manifest = parseManifest(
      JSON.parse(await readFile(join(root, MANIFEST_PATH), 'utf8')) as unknown
    )
    const frontendPath = manifest.frontend
      ? await resolvePackageFile(
          root,
          manifest.frontend.entry,
          manifest.frontend.sha256,
          'frontend'
        )
      : null
    const desktopPath = manifest.desktop
      ? await resolvePackageFile(root, manifest.desktop.command, manifest.desktop.sha256, 'desktop')
      : null
    return { root, manifest, frontendPath, desktopPath }
  }

  async authorizeCapability(pluginRoot: string, capability: string): Promise<boolean> {
    const plugin = await this.inspect(pluginRoot)
    return (
      plugin.manifest.desktop?.capabilities.includes(requiredText(capability, 'capability')) ??
      false
    )
  }

  async start(pluginIdInput: string, pluginRoot: string): Promise<void> {
    const pluginId = normalizePluginId(pluginIdInput)
    if (this.sidecars.has(pluginId)) {
      throw new Error(`Workbench plugin '${pluginId}' is already running`)
    }
    const plugin = await this.inspect(pluginRoot)
    if (plugin.manifest.name !== pluginId) {
      throw new Error('Plugin id must match the package manifest name')
    }
    const desktop = plugin.manifest.desktop
    const command = plugin.desktopPath
    if (!desktop || !command) throw new Error('Plugin does not declare a desktop sidecar')
    const child = spawn(command, desktop.args, {
      cwd: plugin.root,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        WEWORK_PLUGIN_ID: pluginId,
        WEWORK_PLUGIN_ROOT: plugin.root,
      },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    await waitForSpawn(child, pluginId)
    const readline = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.sidecars.set(pluginId, {
      child,
      lines: readline[Symbol.asyncIterator](),
      readline,
      nextRequestId: 1,
      capabilities: new Set(desktop.capabilities),
      requestTail: Promise.resolve(),
    })
  }

  async request(
    pluginIdInput: string,
    capabilityInput: string,
    methodInput: string,
    params: unknown
  ): Promise<unknown> {
    const pluginId = normalizePluginId(pluginIdInput)
    const capability = requiredText(capabilityInput, 'Plugin capability')
    const method = requiredText(methodInput, 'JSON-RPC method')
    const sidecar = this.sidecars.get(pluginId)
    if (!sidecar) throw new Error(`Workbench plugin '${pluginId}' is not running`)
    if (!sidecar.capabilities.has(capability)) {
      throw new Error(
        `Workbench plugin '${pluginId}' is not authorized for capability '${capability}'`
      )
    }
    let release!: () => void
    const previous = sidecar.requestTail
    sidecar.requestTail = new Promise<void>(resolveTail => {
      release = resolveTail
    })
    await previous
    try {
      return await requestSidecar(pluginId, capability, method, params, sidecar)
    } finally {
      release()
    }
  }

  async stop(pluginIdInput: string): Promise<void> {
    const pluginId = normalizePluginId(pluginIdInput)
    const sidecar = this.sidecars.get(pluginId)
    if (!sidecar) return
    this.sidecars.delete(pluginId)
    await terminateProcessTree(sidecar)
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sidecars.keys()].map(pluginId => this.stop(pluginId)))
  }
}

async function requestSidecar(
  pluginId: string,
  capability: string,
  method: string,
  params: unknown,
  sidecar: RunningSidecar
): Promise<unknown> {
  const requestId = sidecar.nextRequestId++
  await writeRequest(sidecar.child, { jsonrpc: '2.0', id: requestId, method, params })
  const responseLine = await readResponseLine(sidecar, pluginId)
  let response: Record<string, unknown>
  try {
    response = JSON.parse(responseLine) as Record<string, unknown>
  } catch (error) {
    throw new Error('Plugin returned invalid JSON-RPC', { cause: error })
  }
  if (response.id !== requestId) {
    throw new Error('Plugin returned a mismatched JSON-RPC response id')
  }
  if (response.error !== undefined)
    throw new Error(`Plugin JSON-RPC error: ${JSON.stringify(response.error)}`)
  return response.result ?? null
}

async function writeRequest(child: PluginChild, request: Record<string, unknown>): Promise<void> {
  const frame = `${JSON.stringify(request)}\n`
  await new Promise<void>((resolveWrite, rejectWrite) => {
    child.stdin.write(frame, error => (error ? rejectWrite(error) : resolveWrite()))
  })
}

async function readResponseLine(sidecar: RunningSidecar, pluginId: string): Promise<string> {
  const next = await sidecar.lines.next()
  if (next.done) {
    throw new Error(`Workbench plugin '${pluginId}' exited before responding`)
  }
  if (Buffer.byteLength(next.value) + 1 > MAX_RESPONSE_BYTES) {
    await terminateProcessTree(sidecar)
    throw new Error(`plugin response exceeds ${MAX_RESPONSE_BYTES} bytes`)
  }
  return next.value
}

async function waitForSpawn(child: PluginChild, pluginId: string): Promise<void> {
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const onSpawn = () => {
      child.off('error', onError)
      resolveSpawn()
    }
    const onError = (error: Error) => {
      child.off('spawn', onSpawn)
      rejectSpawn(new Error(`Failed to start workbench plugin '${pluginId}': ${error.message}`))
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

async function terminateProcessTree(sidecar: RunningSidecar): Promise<void> {
  sidecar.readline.close()
  sidecar.child.stdin.destroy()
  const pid = sidecar.child.pid
  if (!pid || sidecar.child.exitCode !== null) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    await new Promise<void>(resolveKill => killer.once('close', () => resolveKill()))
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return
  }
  const exited = await waitForExit(sidecar.child, 2_000)
  if (exited) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The process exited between the timeout and the signal.
  }
}

function waitForExit(child: PluginChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise(resolveExit => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolveExit(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timeout)
      resolveExit(true)
    }
    child.once('exit', onExit)
  })
}

async function canonicalPluginRoot(rawRoot: string): Promise<string> {
  const input = requiredText(rawRoot, 'Plugin root')
  const root = await realpath(input).catch(error => {
    throw new Error(`Failed to resolve plugin root: ${error}`)
  })
  if (!(await stat(root)).isDirectory()) throw new Error('Plugin root is not a directory')
  if (!(await stat(join(root, MANIFEST_PATH)).catch(() => null))?.isFile()) {
    throw new Error(`Plugin root is missing ${MANIFEST_PATH}`)
  }
  return root
}

async function resolvePackageFile(
  root: string,
  requestedPath: string,
  expectedSha256: string,
  field: string
): Promise<string> {
  if (isAbsolute(requestedPath)) {
    throw new Error(`${field} must resolve to a file inside the plugin package`)
  }
  const path = await realpath(resolve(root, requestedPath)).catch(error => {
    throw new Error(`Failed to resolve ${field}: ${error}`)
  })
  if (!(await stat(path)).isFile() || escapesRoot(root, path)) {
    throw new Error(`${field} must resolve to a file inside the plugin package`)
  }
  const expected = expectedSha256.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`${field} must be a SHA-256 hex digest`)
  const actual = createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
  if (actual !== expected) throw new Error(`${field} SHA-256 mismatch`)
  return path
}

function escapesRoot(root: string, path: string): boolean {
  const value = relative(root, path)
  return (
    value === '..' ||
    value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(value)
  )
}

function parseManifest(value: unknown): WorkbenchPluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${MANIFEST_PATH}: expected an object`)
  }
  const manifest = value as Record<string, unknown>
  const name = normalizePluginId(manifest.name)
  const apiVersion = manifest.apiVersion ?? '1'
  if (apiVersion !== '1') throw new Error(`Unsupported Wework plugin apiVersion '${apiVersion}'`)
  const required = manifest.required === true
  const pinnedToClientVersion = manifest.pinnedToClientVersion === true
  const clientVersion = typeof manifest.clientVersion === 'string' ? manifest.clientVersion : null
  if (required && !pinnedToClientVersion) {
    throw new Error('Required Wework plugins must set pinnedToClientVersion')
  }
  if (pinnedToClientVersion && !clientVersion?.trim()) {
    throw new Error('Pinned Wework plugins must declare clientVersion')
  }
  const frontend = parseFrontend(manifest.frontend)
  const desktop = parseDesktop(manifest.desktop)
  if (!frontend && !desktop) throw new Error('Wework plugin must declare frontend or desktop')
  return {
    name,
    version: typeof manifest.version === 'string' ? manifest.version : null,
    apiVersion: '1',
    required,
    pinnedToClientVersion,
    clientVersion,
    frontend,
    desktop,
  }
}

function parseFrontend(value: unknown): WorkbenchFrontendModule | null {
  if (value == null) return null
  const record = objectValue(value, 'frontend')
  return {
    entry: requiredText(record.entry, 'frontend.entry'),
    export: typeof record.export === 'string' ? record.export : null,
    sha256: requiredText(record.sha256, 'frontend.sha256'),
  }
}

function parseDesktop(value: unknown): WorkbenchDesktopSidecar | null {
  if (value == null) return null
  const record = objectValue(value, 'desktop')
  return {
    command: requiredText(record.command, 'desktop.command'),
    args: stringArray(record.args, 'desktop.args'),
    sha256: requiredText(record.sha256, 'desktop.sha256'),
    capabilities: stringArray(record.capabilities, 'desktop.capabilities'),
  }
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`)
  }
  return value.map(item => item.trim()).filter(Boolean)
}

function normalizePluginId(value: unknown): string {
  const pluginId = requiredText(value, 'Plugin id')
  if (!/^[A-Za-z0-9_-]+$/.test(pluginId)) {
    throw new Error("Plugin id must contain only letters, numbers, '-' or '_'")
  }
  return pluginId
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

function defaultPluginSearchRoots(): string[] {
  return [
    ...(process.env.CODEX_HOME?.trim() ? [join(process.env.CODEX_HOME.trim(), 'plugins')] : []),
    join(homedir(), '.codex', 'plugins'),
    join(homedir(), '.agents', 'plugins'),
    join(homedir(), '.wework', 'plugins'),
  ]
}

async function collectPluginRoots(
  directory: string,
  depth: number,
  output: string[]
): Promise<void> {
  if (depth === 0) return
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => null)
  if (!entries) return
  if (entries.some(entry => entry.isFile() && entry.name === basename(MANIFEST_PATH))) {
    const parent = dirname(MANIFEST_PATH)
    if (
      parent === '.' ||
      (await stat(join(directory, MANIFEST_PATH)).catch(() => null))?.isFile()
    ) {
      output.push(directory)
      return
    }
  }
  if ((await stat(join(directory, MANIFEST_PATH)).catch(() => null))?.isFile()) {
    output.push(directory)
    return
  }
  await Promise.all(
    entries
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => collectPluginRoots(join(directory, entry.name), depth - 1, output))
  )
}
