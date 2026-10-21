import { createRequestCache } from '@wegent/chat-core/request-cache'
import {
  createSharedWorkspaceHttpApi,
  mapCollaborationExecutionEnvironmentDto,
  type CollaborationExecutionEnvironment,
  type RunnerEnvironment,
  type RunnerModel,
} from '@wegent/collaboration'
import type { DeviceListResponse } from '@/types/devices'
import { filterClaudeCodeDevices } from '@/lib/device-capabilities'
import type { HttpClient } from './http'

type NativeCatalog = Pick<RunnerEnvironment, 'models' | 'catalog_error'>
type ReadCatalog = (deviceId: string) => Promise<{ models: RunnerModel[]; errors?: string[] }>

/** Device inventory never starts model discovery. All transports retain their existing permissions. */
export function createAgentRoutingCatalog(client: HttpClient, readCatalog?: ReadCatalog) {
  const cache = createRequestCache(() => client.getCacheScope?.())
  const workspaceApi = createSharedWorkspaceHttpApi(client)
  const personalTypes = new Map<string, string>()
  const environment = (
    device: CollaborationExecutionEnvironment,
    authorized: boolean
  ): RunnerEnvironment => ({
    id: String(device.device_id ?? device.id),
    device_key: device.device_key ?? device.id,
    name: device.name,
    owner_type: device.owner_type,
    owner_id: device.owner_id,
    status:
      device.status === 'online' ? 'online' : device.status === 'offline' ? 'offline' : 'unknown',
    project_authorized: authorized,
    models: [],
    runtimes: device.coding_tools.filter(
      (runtime): runtime is 'codex' | 'claude_code' =>
        runtime === 'codex' || runtime === 'claude_code'
    ),
  })

  return {
    listEnvironments(projectId?: string): Promise<RunnerEnvironment[]> {
      return cache.get(`environments:${projectId ?? ''}`, async () => {
        const [personal, shared, project] = await Promise.all([
          client.get<DeviceListResponse>('/devices'),
          workspaceApi.workspaces
            .list()
            .then(workspaces =>
              Promise.all(
                workspaces.map(workspace =>
                  workspaceApi.workspaces.listExecutionEnvironments(workspace.id)
                )
              )
            ),
          projectId
            ? client
                .get<{
                  items: Record<string, unknown>[]
                }>(`/v1/cloud-projects/${encodeURIComponent(projectId)}/execution-environments`)
                .then(response => response.items.map(mapCollaborationExecutionEnvironmentDto))
            : Promise.resolve([]),
        ])
        const authorized = new Set(
          project
            .filter(device => device.can_use !== false)
            .map(device => String(device.device_id ?? device.id))
        )
        const rows = new Map<string, RunnerEnvironment>()
        personalTypes.clear()
        for (const device of filterClaudeCodeDevices(personal.items)) {
          personalTypes.set(device.device_id, device.device_type)
          rows.set(String(device.id), {
            id: String(device.id),
            device_key: device.device_id,
            name: device.name,
            owner_type: 'user',
            owner_id: '',
            status: device.status === 'offline' ? 'offline' : 'online',
            project_authorized: authorized.has(String(device.id)),
            runtimes: ['codex', 'claude_code'],
            models: [],
          })
        }
        for (const device of [...shared.flat(), ...project]) {
          if (device.can_use === false) continue
          const row = environment(device, authorized.has(String(device.device_id ?? device.id)))
          rows.set(row.id, row)
        }
        return [...rows.values()]
      })
    },
    listNativeModels(target: RunnerEnvironment, projectId?: string): Promise<NativeCatalog> {
      return cache.get(`native:${projectId ?? ''}:${target.id}`, async () => {
        const deviceType = personalTypes.get(target.device_key)
        if (deviceType && deviceType !== 'app' && target.status === 'online' && readCatalog) {
          const result = await readCatalog(target.device_key)
          if (!Array.isArray(result.models)) throw new Error('Invalid runner model catalog')
          return { models: result.models, catalog_error: result.errors?.join(', ') || null }
        }
        // Preserve APP/shared access and the server's last reported offline catalogs.
        const rows = await cache.get(`authorized-catalog:${projectId ?? ''}`, () =>
          client.get<RunnerEnvironment[]>(
            `/v1/resources/execution-environments${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`
          )
        )
        const row = rows.find(row => row.id === target.id)
        if (!row) throw new Error('Runner is no longer available')
        return { models: row.models, catalog_error: row.catalog_error }
      })
    },
  }
}
