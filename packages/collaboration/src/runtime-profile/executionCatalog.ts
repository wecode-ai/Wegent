// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  buildInstalledPluginProjectCatalog,
  type InstalledPluginCatalogItem,
} from '../plugin-catalog'
import type {
  SharedWorkspaceAutomationExecutionCatalogApi,
  WorkspaceAutomationExecutionCatalog,
  WorkspaceAutomationPlugin,
} from '../ports/SharedWorkspaceApi'

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(recordValue(value)).flatMap(([key, item]) =>
      typeof item === 'string' ? [[key, item]] : [],
    ),
  )
}

function mapAutomationExecutionCatalog(
  devicesResponse: unknown,
  modelsResponse: unknown,
  runtimeProfilesResponse: unknown,
): WorkspaceAutomationExecutionCatalog {
  const devices = Array.isArray(recordValue(devicesResponse).items)
    ? (recordValue(devicesResponse).items as Array<Record<string, unknown>>)
    : []
  const models = Array.isArray(recordValue(modelsResponse).data)
    ? (recordValue(modelsResponse).data as Array<Record<string, unknown>>)
    : []
  const runtimeProfiles = Array.isArray(runtimeProfilesResponse)
    ? (runtimeProfilesResponse as Array<Record<string, unknown>>)
    : []

  return {
    environments: devices
      .filter((device) => device.status === 'online')
      .map((device) => ({
        deviceId: String(
          device.device_key ?? device.deviceKey ?? device.device_id ?? '',
        ),
        label: String(
          device.name ??
            device.device_key ??
            device.deviceKey ??
            device.device_id ??
            '',
        ),
        executionEnvironment:
          device.device_type === 'local' || device.kind === 'local_device'
            ? ('local' as const)
            : ('cloud' as const),
      }))
      .filter((environment) => environment.deviceId),
    models: models
      .filter(
        (model) =>
          model.isActive !== false && model.modelCategoryType !== 'image',
      )
      .map((model) => ({
        name: String(model.name ?? ''),
        label: String(model.displayName ?? model.name ?? ''),
        type: ['public', 'user', 'group', 'runtime'].includes(
          String(model.type),
        )
          ? (model.type as 'public' | 'user' | 'group' | 'runtime')
          : null,
        options: {
          ...stringRecord(model.config),
          ...(typeof model.namespace === 'string'
            ? { weworkCloudModelNamespace: model.namespace }
            : {}),
          ...(typeof model.resourceUserId === 'number'
            ? { weworkCloudModelResourceUserId: String(model.resourceUserId) }
            : {}),
        },
      }))
      .filter((model) => model.name),
    runtimeProfiles: runtimeProfiles
      .map((profile) => ({
        ...profile,
        id: String(profile.id ?? ''),
        name: String(profile.name ?? ''),
        executionEnvironment:
          profile.executionEnvironment === 'local'
            ? ('local' as const)
            : ('cloud' as const),
        executionDeviceId: String(profile.executionDeviceId ?? ''),
        model: String(profile.model ?? ''),
        modelType: ['public', 'user', 'group', 'runtime'].includes(
          String(profile.modelType),
        )
          ? (profile.modelType as 'public' | 'user' | 'group' | 'runtime')
          : null,
        modelOptions: stringRecord(profile.modelOptions),
        status:
          profile.status === 'archived'
            ? ('archived' as const)
            : ('active' as const),
        version: Number(profile.version ?? 1),
      }))
      .filter((profile) => profile.id && profile.status === 'active'),
    plugins: [],
  }
}

function mapAutomationPlugins(response: unknown): WorkspaceAutomationPlugin[] {
  const items = Array.isArray(recordValue(response).items)
    ? (recordValue(response).items as InstalledPluginCatalogItem[])
    : []
  return buildInstalledPluginProjectCatalog(items).map((reference) => ({
    id: reference.id,
    label: reference.displayName,
    reference: { ...reference },
  }))
}

export function createAutomationExecutionCatalogApi(client: {
  get<T>(path: string): Promise<T>
}): SharedWorkspaceAutomationExecutionCatalogApi {
  return {
    async load(projectId) {
      const [devices, models, runtimeProfiles] = await Promise.all([
        client.get(
          `/v1/cloud-projects/${encodeURIComponent(projectId)}/execution-environments`,
        ),
        client.get(
          '/models/unified?include_config=true&model_category_type=llm',
        ),
        client.get('/v1/runtime-profiles'),
      ])
      return mapAutomationExecutionCatalog(devices, models, runtimeProfiles)
    },
    async loadPlugins(_projectId, deviceIds) {
      const query =
        deviceIds.length === 1
          ? `?device_id=${encodeURIComponent(deviceIds[0])}`
          : ''
      return mapAutomationPlugins(
        await client.get(`/plugins/installed${query}`),
      )
    },
  }
}
