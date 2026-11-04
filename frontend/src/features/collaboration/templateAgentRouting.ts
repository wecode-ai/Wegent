// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { runnerModelIdentity, type RunnerEnvironment } from '@wegent/collaboration'
import type { TemplateAgentRouting } from '@wegent/collaboration/templates'
import { apiClient } from '@/apis/client'
import { deviceApis } from '@/apis/devices'

/** Web templates follow the user's designated default executor, never an arbitrary device. */
export async function resolveWebTemplateAgentRouting(
  runtime: 'codex' | 'claude_code',
  location: 'local' | 'cloud',
  projectId?: string
): Promise<TemplateAgentRouting> {
  if (location !== 'cloud') throw new Error('template_environment_unavailable')
  const defaults = (await deviceApis.getAllDevices()).items.filter(device => device.is_default)
  if (
    defaults.length !== 1 ||
    defaults[0].device_type === 'app' ||
    defaults[0].status === 'offline'
  )
    throw new Error('template_environment_unavailable')
  const environments = await apiClient.get<RunnerEnvironment[]>(
    `/v1/resources/execution-environments${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`
  )
  const environment = environments.find(item => item.id === String(defaults[0].id))
  if (
    !environment ||
    environment.status !== 'online' ||
    (projectId && !environment.project_authorized)
  )
    throw new Error('template_environment_unavailable')
  if (environment.catalog_error) throw new Error(environment.catalog_error)
  const models = environment.models.filter(model => model.runtime === runtime && model.is_default)
  if (models.length !== 1) throw new Error('template_model_default_unavailable')
  return {
    executionPolicy: { mode: 'fixed', environment_id: environment.id },
    modelPolicy: { mode: 'fixed', model: runnerModelIdentity(models[0]) },
  }
}
