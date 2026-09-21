import type { RuntimeEvent } from '@wegent/chat-core'
import type { DeviceInfo, InstalledPlugin, RuntimeTaskSummary } from '@/types/api'
import { trackPluginInvocationEvent } from '@/telemetry/businessEvents'

type PluginDistribution = 'official' | 'enterprise' | 'personal' | 'unknown'
type ExecutorLocation = 'local' | 'cloud' | 'remote' | 'unknown'
type ExecutionSurface = 'task' | 'project_task' | 'automation' | 'unknown'
type PluginCapabilityType = 'mcp' | 'skill'

interface PendingInvocation {
  capabilityType: PluginCapabilityType
  distribution: PluginDistribution
  executorLocation: ExecutorLocation
  executionSurface: ExecutionSurface
  marketplace: string
  pluginKey: string
  toolName: string
  version: string
}

interface PluginOwner {
  distribution: PluginDistribution
  marketplace: string
  pluginKey: string
  version: string
}

const MAX_TRACKED_INVOCATIONS = 1_000
const mcpOwnersByDevice = new Map<string, Map<string, PluginOwner | null>>()
const pluginOwnersByDevice = new Map<string, Map<string, PluginOwner | null>>()
const pluginRootOwnersByDevice = new Map<string, Map<string, PluginOwner | null>>()
const executorLocations = new Map<string, ExecutorLocation>()
const taskSurfaces = new Map<string, ExecutionSurface>()
const pendingInvocations = new Map<string, PendingInvocation>()
const completedInvocations = new Set<string>()

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

function pluginDistribution(plugin: InstalledPlugin): PluginDistribution {
  const payload = record(plugin.spec.sourcePayload)
  const marketplace = String(
    payload.marketplaceName ??
      plugin.spec.source.marketplace ??
      plugin.spec.source.providerKey ??
      ''
  ).toLowerCase()
  if (
    plugin.spec.visibility === 'personal' ||
    plugin.spec.sourceProvider === 'user' ||
    marketplace.includes('personal')
  ) {
    return 'personal'
  }
  if (plugin.spec.visibility === 'workspace' || marketplace === 'wegent') return 'enterprise'
  if (
    plugin.spec.sourceProvider === 'codex' ||
    marketplace === 'wework' ||
    marketplace.includes('openai')
  ) {
    return 'official'
  }
  return 'unknown'
}

function normalizedServerName(value: string): string {
  return value.trim().toLowerCase()
}

function normalizedPluginId(value: string): string {
  return value.trim().toLowerCase()
}

function normalizedPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()
}

function pluginRootFromSkillPath(value: string): string | null {
  const path = normalizedPath(value)
  if (!path.startsWith('/') && !/^[a-z]:\//.test(path)) return null
  const cacheMarker = '/plugins/cache/'
  const cacheIndex = path.indexOf(cacheMarker)
  if (cacheIndex >= 0) {
    const relativeParts = path.slice(cacheIndex + cacheMarker.length).split('/')
    if (relativeParts.length >= 3 && relativeParts.slice(0, 3).every(Boolean)) {
      return `${path.slice(0, cacheIndex + cacheMarker.length)}${relativeParts.slice(0, 3).join('/')}`
    }
  }
  const skillsIndex = path.indexOf('/skills/')
  return skillsIndex > 0 ? path.slice(0, skillsIndex) : null
}

function rememberOwner(
  owners: Map<string, PluginOwner | null>,
  rawKey: unknown,
  owner: PluginOwner
): void {
  if (typeof rawKey !== 'string') return
  const key = normalizedPluginId(rawKey)
  if (!key) return
  const existing = owners.get(key)
  owners.set(
    key,
    existing &&
      (existing.pluginKey !== owner.pluginKey || existing.marketplace !== owner.marketplace)
      ? null
      : owner
  )
}

export function publishPluginInvocationCatalog(
  deviceId: string,
  localPlugins: readonly InstalledPlugin[],
  cloudPlugins: readonly InstalledPlugin[]
): void {
  const owners = new Map<string, PluginOwner | null>()
  const pluginOwners = new Map<string, PluginOwner | null>()
  const pluginRootOwners = new Map<string, PluginOwner | null>()
  for (const plugin of [...localPlugins, ...cloudPlugins]) {
    if (
      !plugin.spec.enabled ||
      !['installed', 'update_available'].includes(plugin.spec.installState)
    ) {
      continue
    }
    const payload = record(plugin.spec.sourcePayload)
    const marketplace = String(
      payload.marketplaceName ??
        plugin.spec.source.marketplace ??
        plugin.spec.source.providerKey ??
        'unknown'
    )
    const pluginKey = plugin.spec.source.pluginKey || String(plugin.metadata.name ?? 'unknown')
    const owner: PluginOwner = {
      distribution: pluginDistribution(plugin),
      marketplace,
      pluginKey,
      version: plugin.spec.version ?? plugin.spec.desiredVersion ?? 'unknown',
    }
    const manifest = record(plugin.spec.manifest)
    rememberOwner(pluginOwners, plugin.spec.source.pluginKey, owner)
    rememberOwner(pluginOwners, plugin.metadata.name, owner)
    rememberOwner(pluginOwners, record(plugin.metadata.labels).id, owner)
    rememberOwner(pluginOwners, payload.pluginId, owner)
    rememberOwner(pluginOwners, payload.localId, owner)
    rememberOwner(pluginOwners, payload.remotePluginId, owner)
    rememberOwner(pluginOwners, manifest.id, owner)
    rememberOwner(pluginOwners, `${pluginKey}@${marketplace}`, owner)
    for (const skill of plugin.spec.components.skills ?? []) {
      const pluginRoot = pluginRootFromSkillPath(skill.path)
      if (pluginRoot) rememberOwner(pluginRootOwners, pluginRoot, owner)
    }
    for (const mcp of plugin.spec.components.mcps ?? []) {
      const serverName = normalizedServerName(mcp.name)
      if (!serverName) continue
      const existing = owners.get(serverName)
      owners.set(
        serverName,
        existing &&
          (existing.pluginKey !== owner.pluginKey || existing.marketplace !== owner.marketplace)
          ? null
          : owner
      )
    }
  }
  mcpOwnersByDevice.set(deviceId, owners)
  pluginOwnersByDevice.set(deviceId, pluginOwners)
  pluginRootOwnersByDevice.set(deviceId, pluginRootOwners)
}

export function publishPluginInvocationDevices(devices: readonly DeviceInfo[]): void {
  executorLocations.clear()
  for (const device of devices) {
    const location: ExecutorLocation =
      device.device_type === 'local' || device.device_type === 'app'
        ? 'local'
        : device.device_type === 'cloud'
          ? 'cloud'
          : device.device_type === 'remote'
            ? 'remote'
            : 'unknown'
    executorLocations.set(device.device_id, location)
  }
}

export function publishPluginInvocationTask(
  deviceId: string,
  taskId: string,
  task: Pick<RuntimeTaskSummary, 'runtimeHandle'> | null
): void {
  const handle = record(task?.runtimeHandle)
  const origin = record(handle.origin)
  const originType = stringField(origin, 'type')
  const surface: ExecutionSurface =
    originType === 'project_automation'
      ? 'automation'
      : originType === 'board_task' || originType === 'board_comment'
        ? 'project_task'
        : handle.cloudProjectId != null || handle.cloud_project_id != null
          ? 'project_task'
          : 'task'
  taskSurfaces.set(`${deviceId}:${taskId}`, surface)
  if (taskSurfaces.size > MAX_TRACKED_INVOCATIONS) {
    taskSurfaces.delete(taskSurfaces.keys().next().value!)
  }
}

function serverNameForTool(deviceId: string, toolName: string): string | null {
  const owners = mcpOwnersByDevice.get(deviceId)
  if (!owners || owners.size === 0) return null
  const normalized = toolName.trim().toLowerCase()
  return (
    [...owners.keys()]
      .sort((left, right) => right.length - left.length)
      .find(
        server =>
          normalized === server ||
          normalized.startsWith(`${server}.`) ||
          normalized.startsWith(`${server}__`) ||
          normalized.startsWith(`mcp__${server}__`)
      ) ?? null
  )
}

function invocationKey(payload: Record<string, unknown>, blockId: string): string | null {
  const deviceId = stringField(payload, 'deviceId', 'device_id')
  const taskId = stringField(payload, 'taskId', 'task_id')
  if (!deviceId || !taskId || !blockId) return null
  const subtaskId = stringField(payload, 'subtaskId', 'subtask_id') ?? ''
  return `${deviceId}:${taskId}:${subtaskId}:${blockId}`
}

function fallbackOwner(pluginId: string): PluginOwner {
  const [pluginKey, ...marketplaceParts] = pluginId.split('@')
  const marketplace = marketplaceParts.join('@') || 'unknown'
  const normalizedMarketplace = marketplace.toLowerCase()
  const distribution: PluginDistribution = normalizedMarketplace.includes('personal')
    ? 'personal'
    : normalizedMarketplace.includes('openai') || normalizedMarketplace.includes('official')
      ? 'official'
      : normalizedMarketplace === 'wegent' || normalizedMarketplace.includes('enterprise')
        ? 'enterprise'
        : 'unknown'
  return { distribution, marketplace, pluginKey: pluginKey || pluginId, version: 'unknown' }
}

function commandText(block: Record<string, unknown>): string | null {
  const input = record(block.toolInput ?? block.tool_input)
  const direct = stringField(input, 'cmd', 'command', 'commandLine', 'command_line')
  if (direct) return direct
  const command = input.command
  if (!Array.isArray(command)) return null
  const parts = command.filter((part): part is string => typeof part === 'string' && !!part)
  return parts.length > 0 ? parts.join(' ') : null
}

function skillOwnerForBlock(
  deviceId: string,
  block: Record<string, unknown>,
  toolName: string
): PluginOwner | null {
  if (!['bash', 'exec_command', 'shell', 'local_shell'].includes(toolName.toLowerCase()))
    return null
  const command = commandText(block)
  const owners = pluginRootOwnersByDevice.get(deviceId)
  if (!command || !owners || owners.size === 0) return null
  const normalizedCommand = normalizedPath(command)
  const root = [...owners.keys()]
    .sort((left, right) => right.length - left.length)
    .find(candidate => normalizedCommand.includes(`${candidate}/`))
  return root ? (owners.get(root) ?? null) : null
}

function invocationContext(
  payload: Record<string, unknown>,
  block: Record<string, unknown>,
  toolName: string
): PendingInvocation | null {
  const deviceId = stringField(payload, 'deviceId', 'device_id')
  const taskId = stringField(payload, 'taskId', 'task_id')
  if (!deviceId || !taskId) return null
  const pluginId = stringField(block, 'pluginId', 'plugin_id')
  const serverName =
    stringField(block, 'mcpServer', 'mcp_server') ?? serverNameForTool(deviceId, toolName)
  const mcpOwner = pluginId
    ? (pluginOwnersByDevice.get(deviceId)?.get(normalizedPluginId(pluginId)) ??
      fallbackOwner(pluginId))
    : serverName
      ? mcpOwnersByDevice.get(deviceId)?.get(normalizedServerName(serverName))
      : null
  const owner = mcpOwner ?? skillOwnerForBlock(deviceId, block, toolName)
  if (!owner) return null
  return {
    capabilityType: mcpOwner ? 'mcp' : 'skill',
    distribution: owner.distribution,
    executorLocation: executorLocations.get(deviceId) ?? 'unknown',
    executionSurface: taskSurfaces.get(`${deviceId}:${taskId}`) ?? 'unknown',
    marketplace: owner.marketplace,
    pluginKey: owner.pluginKey,
    toolName,
    version: owner.version,
  }
}

function rememberPending(key: string, context: PendingInvocation): void {
  if (completedInvocations.has(key)) return
  pendingInvocations.set(key, context)
  if (pendingInvocations.size > MAX_TRACKED_INVOCATIONS) {
    pendingInvocations.delete(pendingInvocations.keys().next().value!)
  }
}

function completeInvocation(
  key: string,
  context: PendingInvocation,
  outcome: 'succeeded' | 'failed',
  durationMs?: number
): void {
  if (completedInvocations.has(key)) return
  completedInvocations.add(key)
  pendingInvocations.delete(key)
  if (completedInvocations.size > MAX_TRACKED_INVOCATIONS) {
    completedInvocations.delete(completedInvocations.values().next().value!)
  }
  const properties = {
    capability_type: context.capabilityType,
    execution_surface: context.executionSurface,
    executor_location: context.executorLocation,
    plugin_distribution: context.distribution,
  }
  const pluginInvocation = {
    ...(durationMs !== undefined && { durationMs }),
    marketplace: context.marketplace,
    pluginKey: context.pluginKey,
    toolName: context.toolName,
    version: context.version,
  }
  if (outcome === 'succeeded') {
    trackPluginInvocationEvent('plugin_invocation_succeeded', properties, pluginInvocation)
  } else {
    trackPluginInvocationEvent(
      'plugin_invocation_failed',
      {
        ...properties,
        failure_stage: 'invoke',
      },
      pluginInvocation
    )
  }
}

export function observeRuntimePluginInvocation(event: RuntimeEvent): void {
  if (event.event !== 'response.block.created' && event.event !== 'response.block.updated') return
  const payload = record(event.payload)
  const data = record(payload.data)
  const block = record(data.block)
  if (event.event === 'response.block.created') {
    if (block.type !== 'tool') return
    const blockId = stringField(block, 'id')
    const toolName = stringField(block, 'toolName', 'tool_name')
    if (!blockId || !toolName) return
    const key = invocationKey(payload, blockId)
    const context = invocationContext(payload, block, toolName)
    if (!key || !context) return
    const status = stringField(block, 'status')
    const durationMs = typeof block.durationMs === 'number' ? block.durationMs : undefined
    if (status === 'done') completeInvocation(key, context, 'succeeded', durationMs)
    else if (status === 'error') completeInvocation(key, context, 'failed', durationMs)
    else rememberPending(key, context)
    return
  }

  const blockId = stringField(data, 'blockId', 'block_id') ?? stringField(block, 'id')
  if (!blockId) return
  const key = invocationKey(payload, blockId)
  if (!key) return
  const toolName = stringField(block, 'toolName', 'tool_name')
  const context =
    pendingInvocations.get(key) ??
    (block.type === 'tool' && toolName ? invocationContext(payload, block, toolName) : null)
  if (!context) return
  const updates = record(data.updates)
  const status = stringField(updates, 'status') ?? stringField(block, 'status')
  const durationMs =
    typeof updates.durationMs === 'number'
      ? updates.durationMs
      : typeof block.durationMs === 'number'
        ? block.durationMs
        : undefined
  if (status === 'done') completeInvocation(key, context, 'succeeded', durationMs)
  else if (status === 'error') completeInvocation(key, context, 'failed', durationMs)
  else rememberPending(key, context)
}

export function resetPluginInvocationTelemetryForTest(): void {
  mcpOwnersByDevice.clear()
  pluginOwnersByDevice.clear()
  pluginRootOwnersByDevice.clear()
  executorLocations.clear()
  taskSurfaces.clear()
  pendingInvocations.clear()
  completedInvocations.clear()
}
