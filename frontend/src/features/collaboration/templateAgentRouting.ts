// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { runnerModelIdentity, type RunnerEnvironment } from '@wegent/collaboration'
import type { TemplateAgentRouting } from '@wegent/collaboration/templates'
import { apiClient } from '@/apis/client'
import { deviceApis } from '@/apis/devices'
import { createWebSharedWorkspaceApi } from './shared-api'

async function defaultEnvironmentId(): Promise<string | undefined> {
  const defaults = (await deviceApis.getAllDevices()).items.filter(device => device.is_default)
  return defaults.length === 1 && defaults[0].status !== 'offline'
    ? String(defaults[0].id)
    : undefined
}

export function listWebTemplateAgentEnvironments(projectId: string) {
  return createWebSharedWorkspaceApi(apiClient).projects.listExecutionEnvironments(projectId)
}

/** Existing projects resolve within their authorized pool; new projects use the account default. */
export async function resolveWebTemplateAgentRouting(
  runtime: 'codex' | 'claude_code',
  location: 'local' | 'cloud',
  projectId?: string,
  environmentId?: string
): Promise<TemplateAgentRouting> {
  if (location !== 'cloud') throw new Error('template_environment_unavailable')
  const defaultId = projectId || environmentId ? undefined : await defaultEnvironmentId()
  if (!projectId && !environmentId && !defaultId)
    throw new Error('template_environment_unavailable')
  const environments = await apiClient.get<RunnerEnvironment[]>(
    `/v1/resources/execution-environments${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`
  )
  const available = environments.filter(
    item => item.status === 'online' && (!projectId || item.project_authorized)
  )
  const preferredId =
    environmentId ?? (projectId && available.length > 1 ? await defaultEnvironmentId() : defaultId)
  const environment =
    !environmentId && projectId && available.length === 1
      ? available[0]
      : available.find(item => item.id === preferredId)
  if (!environment)
    throw new Error(
      !environmentId && projectId && available.length > 1
        ? 'template_environment_ambiguous'
        : 'template_environment_unavailable'
    )
  if (environment.catalog_error) throw new Error(environment.catalog_error)
  const models = environment.models.filter(model => model.runtime === runtime && model.is_default)
  if (models.length !== 1) throw new Error('template_model_default_unavailable')
  return {
    executionPolicy: { mode: 'fixed', environment_id: environment.id },
    modelPolicy: { mode: 'fixed', model: runnerModelIdentity(models[0]) },
  }
}
